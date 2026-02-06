import { config } from '../config.js';

function normalize(text: string): string {
  return text.toLowerCase();
}

export function getBrandAnchors(): string[] {
  const anchors: string[] = [];

  for (const term of config.brandRequiredTerms) {
    const normalized = term.trim();
    if (normalized) anchors.push(normalized);
  }

  if (config.playstoreAppId) {
    anchors.push(config.playstoreAppId);
    anchors.push(`play.google.com/store/apps/details?id=${config.playstoreAppId}`);
  }

  if (config.appstoreAppId) {
    anchors.push(`id${config.appstoreAppId}`);
    anchors.push(`apps.apple.com/app/id${config.appstoreAppId}`);
  }

  return Array.from(new Set(anchors));
}

export function getStrongBrandAnchors(): string[] {
  return getBrandAnchors().filter(term => {
    const normalized = term.toLowerCase();
    return normalized.includes('.') ||
      normalized.includes('/') ||
      normalized.startsWith('id') ||
      normalized.includes('play.google.com') ||
      normalized.includes('apps.apple.com');
  });
}

export function matchesBrand(text: string | null | undefined): boolean {
  if (!text) return false;
  const haystack = normalize(text);

  if (config.brandStrict) {
    const strong = getStrongBrandAnchors().map(term => normalize(term)).filter(Boolean);
    if (strong.length > 0) {
      return strong.some(term => haystack.includes(term));
    }
    const requiredFallback = getBrandAnchors().map(term => normalize(term)).filter(Boolean);
    if (requiredFallback.length > 0) {
      return requiredFallback.some(term => haystack.includes(term));
    }
  } else {
    const required = getBrandAnchors().map(term => normalize(term)).filter(Boolean);
    if (required.length > 0) {
      return required.some(term => haystack.includes(term));
    }
  }

  const search = config.searchTerms.map(term => normalize(term)).filter(Boolean);
  if (search.length > 0) {
    return search.some(term => haystack.includes(term));
  }

  return false;
}

export function matchesBrandBalanced(text: string | null | undefined, contextKeywords: string[]): boolean {
  if (!text) return false;
  const haystack = normalize(text);

  // Always allow strong/required anchors
  if (matchesBrand(haystack)) return true;

  // Balanced mode: require explicit "matiks" plus app/game/math context
  if (!haystack.includes('matiks')) return false;
  return contextKeywords.some(keyword => haystack.includes(normalize(keyword)));
}
