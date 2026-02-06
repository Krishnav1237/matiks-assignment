import { Page } from 'playwright';

// Random delay between min and max milliseconds
export function randomDelay(min: number, max: number): Promise<void> {
  const delay = min + Math.random() * (max - min);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Human-like typing with variable speed and occasional pauses
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await randomDelay(100, 300);
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Type character with variable delay
    await page.type(selector, char, { delay: 50 + Math.random() * 100 });
    
    // Occasional longer pause (thinking)
    if (Math.random() < 0.05) {
      await randomDelay(200, 500);
    }
    
    // Very rare typo and correction (makes it more human)
    if (Math.random() < 0.01 && i < text.length - 1) {
      const typo = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      await page.type(selector, typo, { delay: 80 });
      await randomDelay(100, 200);
      await page.keyboard.press('Backspace');
      await randomDelay(50, 150);
    }
  }
}

// Human-like mouse movement with bezier curve
export async function humanMouseMove(page: Page, x: number, y: number): Promise<void> {
  const steps = 10 + Math.floor(Math.random() * 15);
  const currentPos = { x: 0, y: 0 };
  
  // Generate control point for bezier curve
  const cpX = currentPos.x + (x - currentPos.x) * (0.3 + Math.random() * 0.4);
  const cpY = currentPos.y + (y - currentPos.y) * (0.3 + Math.random() * 0.4);
  
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    
    // Quadratic bezier
    const newX = mt2 * currentPos.x + 2 * mt * t * cpX + t2 * x;
    const newY = mt2 * currentPos.y + 2 * mt * t * cpY + t2 * y;
    
    await page.mouse.move(newX, newY);
    await randomDelay(5, 15);
  }
}

// Human-like click with movement
export async function humanClick(page: Page, selector: string): Promise<void> {
  const element = await page.$(selector);
  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }
  
  const box = await element.boundingBox();
  if (!box) {
    throw new Error(`Could not get bounding box: ${selector}`);
  }
  
  // Click somewhere within the element (not always center)
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  
  await humanMouseMove(page, x, y);
  await randomDelay(50, 150);
  await page.mouse.click(x, y);
  await randomDelay(100, 300);
}

// Human-like scrolling
export async function humanScroll(page: Page, distance: number): Promise<void> {
  const steps = Math.abs(distance) > 500 ? 5 : 3;
  const stepDistance = distance / steps;
  
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDistance + (Math.random() - 0.5) * 50);
    await randomDelay(100, 300);
    
    // Occasionally pause while scrolling (reading)
    if (Math.random() < 0.2) {
      await randomDelay(500, 1500);
    }
  }
}

// Session warmup - browse around before targeted action
export async function warmupSession(page: Page, urls: string[]): Promise<void> {
  for (const url of urls.slice(0, 2)) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await randomDelay(2000, 4000);
      await humanScroll(page, 300 + Math.random() * 400);
      await randomDelay(1000, 2000);
    } catch (e) {
      // Ignore warmup errors
    }
  }
}

// Wait and ensure page is loaded
export async function waitForPageLoad(page: Page, timeout = 10000): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    await randomDelay(500, 1000);
  } catch (e) {
    // Continue even if timeout
  }
}

// Extract text safely
export async function safeGetText(page: Page, selector: string): Promise<string | null> {
  try {
    const element = await page.$(selector);
    if (!element) return null;
    return await element.textContent();
  } catch {
    return null;
  }
}

// Extract attribute safely
export async function safeGetAttr(page: Page, selector: string, attr: string): Promise<string | null> {
  try {
    const element = await page.$(selector);
    if (!element) return null;
    return await element.getAttribute(attr);
  } catch {
    return null;
  }
}
