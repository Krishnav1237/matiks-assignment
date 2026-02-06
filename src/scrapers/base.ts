import { BrowserContext, Page } from 'playwright';
import { createStealthContext, saveCookies, closeBrowser } from '../core/browser.js';
import { rateLimit, reportSuccess, reportFailure, withRetry } from '../core/rateLimit.js';
import { logger } from '../core/logger.js';
import { logScrapeStart, logScrapeEnd, PlatformName } from '../db/queries.js';
import { analyzeSentiment } from '../pipeline/sentiment.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface ScraperResult<T> {
  items: T[];
  newItems: number;
  errors: string[];
}

export abstract class BaseScraper<T> {
  protected platform: PlatformName;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected logId: number = 0;
  
  constructor(platform: PlatformName) {
    this.platform = platform;
  }
  
  // Abstract methods to implement
  protected abstract scrapeData(): Promise<T[]>;
  protected abstract saveData(items: T[]): number;
  
  // Optional hooks
  protected async beforeScrape(): Promise<void> {}
  protected async afterScrape(): Promise<void> {}
  
  // Main run method
  async run(): Promise<ScraperResult<T>> {
    const errors: string[] = [];
    let items: T[] = [];
    let newItems = 0;
    
    logger.info(`Starting ${this.platform} scrape`);
    this.logId = logScrapeStart(this.platform);
    
    try {
      // Rate limit before starting
      await rateLimit(this.platform);
      
      // Create browser context
      this.context = await createStealthContext({
        platform: this.platform,
        useProxy: ['twitter', 'linkedin'].includes(this.platform),
        loadCookies: true,
      });
      
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(30000);
      this.page.setDefaultNavigationTimeout(45000);
      
      // Lifecycle hooks
      await this.beforeScrape();
      
      // Run scraping with retry
      items = await withRetry(
        () => this.scrapeData(),
        { maxRetries: 2, platform: this.platform }
      );
      
      // Analyze sentiment
      items = this.enrichWithSentiment(items);
      
      // Save to database
      newItems = this.saveData(items);
      
      await this.afterScrape();
      
      // Save cookies for session persistence
      if (this.context) {
        await saveCookies(this.context, this.platform);
      }
      
      reportSuccess(this.platform);
      logScrapeEnd(this.logId, 'success', items.length, newItems);
      
      logger.info(`${this.platform} scrape complete: ${items.length} found, ${newItems} new`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      reportFailure(this.platform);
      logScrapeEnd(this.logId, 'failed', items.length, newItems, errorMessage);
      
      logger.error(`${this.platform} scrape failed: ${errorMessage}`);
      
      await this.captureErrorScreenshot();
      
    } finally {
      // Cleanup
      if (this.page) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
    }
    
    return { items, newItems, errors };
  }
  
  // Enrich items with sentiment - override in subclass if needed
  protected enrichWithSentiment(items: T[]): T[] {
    return items.map(item => {
      const content = (item as any).content || (item as any).title || '';
      const sentiment = analyzeSentiment(content);
      return {
        ...item,
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
      };
    });
  }

  private async captureErrorScreenshot(): Promise<void> {
    try {
      if (!this.page) return;
      const debugDir = path.join(config.paths.logs, 'debug');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      const filePath = path.join(debugDir, `${this.platform}-error-${Date.now()}.png`);
      await this.page.screenshot({ path: filePath, fullPage: true });
      logger.warn(`${this.platform} error screenshot saved: ${filePath}`);
    } catch {
      // Ignore screenshot failures
    }
  }
  
  // Helper to safely extract text
  protected async getText(selector: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      const element = await this.page.$(selector);
      if (!element) return null;
      return (await element.textContent())?.trim() || null;
    } catch {
      return null;
    }
  }
  
  // Helper to safely extract attribute
  protected async getAttr(selector: string, attr: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      const element = await this.page.$(selector);
      if (!element) return null;
      return await element.getAttribute(attr);
    } catch {
      return null;
    }
  }
  
  // Helper to wait for selector
  protected async waitFor(selector: string, timeout = 10000): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }
}
