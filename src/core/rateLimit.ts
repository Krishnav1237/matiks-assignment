import { config } from '../config.js';
import { logger } from './logger.js';

interface RateLimitState {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number; // tokens per second
  backoffMultiplier: number;
  lastRequest: number;
}

const limiters: Map<string, RateLimitState> = new Map();

// Initialize rate limiter for a platform
function getOrCreateLimiter(platform: string): RateLimitState {
  if (!limiters.has(platform)) {
    const rpm = config.rateLimits[platform as keyof typeof config.rateLimits] || 5;
    const refillRate = rpm / 60; // Convert RPM to tokens per second
    
    limiters.set(platform, {
      tokens: 5, // Start with some tokens
      lastRefill: Date.now(),
      maxTokens: 10,
      refillRate,
      backoffMultiplier: 1,
      lastRequest: 0,
    });
  }
  return limiters.get(platform)!;
}

// Refill tokens based on elapsed time
function refillTokens(state: RateLimitState): void {
  const now = Date.now();
  const elapsed = (now - state.lastRefill) / 1000;
  const tokensToAdd = elapsed * state.refillRate;
  
  state.tokens = Math.min(state.maxTokens, state.tokens + tokensToAdd);
  state.lastRefill = now;
}

// Wait for rate limit
export async function rateLimit(platform: string): Promise<void> {
  const state = getOrCreateLimiter(platform);
  refillTokens(state);
  
  if (state.tokens < 1) {
    // Calculate wait time
    const tokensNeeded = 1 - state.tokens;
    const waitTime = (tokensNeeded / state.refillRate) * 1000 * state.backoffMultiplier;
    
    logger.debug(`Rate limiting ${platform}: waiting ${Math.round(waitTime)}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    refillTokens(state);
  }
  
  // Consume token
  state.tokens -= 1;
  state.lastRequest = Date.now();
  
  // Add random jitter to make requests less predictable
  const jitter = 500 + Math.random() * 1500;
  await new Promise(resolve => setTimeout(resolve, jitter));
}

// Report success - reduce backoff
export function reportSuccess(platform: string): void {
  const state = getOrCreateLimiter(platform);
  state.backoffMultiplier = Math.max(1, state.backoffMultiplier * 0.9);
}

// Report failure - increase backoff
export function reportFailure(platform: string): void {
  const state = getOrCreateLimiter(platform);
  state.backoffMultiplier = Math.min(10, state.backoffMultiplier * 2);
  state.tokens = 0; // Drain tokens on failure
  
  logger.warn(`Rate limit backoff for ${platform}: ${state.backoffMultiplier}x`);
}

// Get current state for monitoring
export function getRateLimitState(platform: string): { tokensAvailable: number; backoff: number } | null {
  const state = limiters.get(platform);
  if (!state) return null;
  
  refillTokens(state);
  return {
    tokensAvailable: Math.floor(state.tokens),
    backoff: state.backoffMultiplier,
  };
}

// Exponential backoff helper
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    platform?: string;
  } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 30000, platform } = options;
  
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (platform) reportSuccess(platform);
      return result;
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        
        logger.warn(`Attempt ${attempt + 1} failed, retrying in ${Math.round(jitter)}ms: ${lastError.message}`);
        
        if (platform) reportFailure(platform);
        await new Promise(resolve => setTimeout(resolve, jitter));
      }
    }
  }
  
  throw lastError;
}
