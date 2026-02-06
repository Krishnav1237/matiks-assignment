import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config.js';
import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';

// Ensure cookies directory exists
if (!fs.existsSync(config.paths.cookies)) {
  fs.mkdirSync(config.paths.cookies, { recursive: true });
}

let browserInstance: Browser | null = null;
let isClosing = false;

// Launch browser with stealth settings
export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  
  if (isClosing) {
    throw new Error('Browser is currently closing, cannot launch new instance');
  }
  
  logger.info('Launching browser with stealth configuration');
  
  try {
    browserInstance = await chromium.launch({
      headless: config.browser.headless,
      slowMo: config.browser.slowMo || 0,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1366,768',
      ],
    });
    
    // Safety Net: Ensure browser closes if node process exits
    if (process.listenerCount('SIGINT') === 0) {
      setupSignalHandlers();
    }
    
    browserInstance.on('disconnected', () => {
      logger.warn('Browser disconnected unexpectedly');
      browserInstance = null;
    });

    return browserInstance;
  } catch (error) {
    logger.error('Failed to launch browser', { error });
    throw error;
  }
}

function setupSignalHandlers() {
  const handler = async (signal: string) => {
    logger.info(`Received ${signal}, closing browser...`);
    await closeBrowser();
    process.exit(0);
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
  // Handle unhandled rejections to prevent zombie processes
  process.on('unhandledRejection', async (err) => {
    logger.error('Unhandled Rejection, cleaning up browser', { error: err });
    await closeBrowser();
    process.exit(1);
  });
}

// Create a stealth context
export async function createStealthContext(options: {
  platform: string;
  useProxy?: boolean;
  loadCookies?: boolean;
}): Promise<BrowserContext> {
  const browser = await getBrowser();
  
  // Random viewport from common resolutions
  const viewports = [
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ];
  const viewport = viewports[Math.floor(Math.random() * viewports.length)];
  
  // Random user agent
  const userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const platformValue = userAgent.includes('Windows') ? 'Win32' : 'MacIntel';
  const hardwareConcurrency = [4, 8, 12, 16][Math.floor(Math.random() * 4)];
  const deviceMemory = [4, 8][Math.floor(Math.random() * 2)];
  
  const contextOptions: any = {
    viewport,
    userAgent,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    colorScheme: 'light',
  };
  
  // Add proxy if configured and requested
  if (options.useProxy && config.proxy) {
    contextOptions.proxy = config.proxy;
    logger.debug(`Using proxy: ${config.proxy.server}`);
  }
  
  const context = await browser.newContext(contextOptions);
  
  // Add stealth scripts to every page
  await context.addInitScript(
    ({ platformValue, hardwareConcurrency, deviceMemory }) => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Override platform
    Object.defineProperty(navigator, 'platform', {
      get: () => platformValue,
    });
    
    // Override hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => hardwareConcurrency,
    });
    
    // Override deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => deviceMemory,
    });
    
    // Fix chrome object
    (window as any).chrome = {
      runtime: {},
    };
    
    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: any) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission } as PermissionStatus) :
        originalQuery(parameters)
    );
  },
    { platformValue, hardwareConcurrency, deviceMemory }
  );
  
  // Load cookies if requested
  if (options.loadCookies) {
    const cookiePath = path.join(config.paths.cookies, `${options.platform}.json`);
    if (fs.existsSync(cookiePath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      await context.addCookies(cookies);
      logger.debug(`Loaded cookies for ${options.platform}`);
    }
  }
  
  return context;
}

// Save cookies for a platform
export async function saveCookies(context: BrowserContext, platform: string): Promise<void> {
  const cookies = await context.cookies();
  const cookiePath = path.join(config.paths.cookies, `${platform}.json`);
  fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
  logger.debug(`Saved cookies for ${platform}`);
}

// Close browser
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    isClosing = true;
    try {
      await browserInstance.close();
      logger.info('Browser closed');
    } catch (error) {
      logger.error('Error closing browser', { error });
    } finally {
      browserInstance = null;
      isClosing = false;
    }
  }
}
