import { Page, BrowserContext } from 'playwright';
import { createStealthContext, closeBrowser } from '../core/browser.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { Review, insertReviews, PLATFORMS, logScrapeStart, logScrapeEnd, getScrapeCursor, updateScrapeCursor } from '../db/queries.js';
import { analyzeSentiment } from '../pipeline/sentiment.js';
import { randomDelay } from '../core/humanize.js';
import { createHash } from 'crypto';
import { rateLimit, withRetry } from '../core/rateLimit.js';

interface AppStoreReview {
  id: string;
  author: string;
  rating: number;
  title: string;
  content: string;
  version: string;
  updated: string;
  country: string;
}

export class AppStoreScraper {
  private platform = 'appstore' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  
  // Comprehensive list of App Store countries
  private readonly countries = [
    'in', 'us', 'gb', 'ca', 'au', 'nz',
    'sg', 'my', 'ph', 'id', 'th', 'vn', 'pk', 'bd', 'lk', 'np',
    'ae', 'sa', 'za', 'eg', 'ng', 'ke',
    'de', 'fr', 'it', 'es', 'nl', 'be', 'pt', 'pl', 'ru', 'tr', 'se', 'no', 'dk', 'fi', 'at', 'ch', 'ie',
    'mx', 'br', 'ar', 'cl', 'co', 'pe',
    'jp', 'kr', 'tw', 'hk', 'cn'
  ];
  
  async run(): Promise<{ items: Review[]; newItems: number; errors: string[] }> {
    const errors: string[] = [];
    let newItems = 0;
    
    // Check if we have scraped before
    const cursor = getScrapeCursor('appstore');
    const isIncremental = !!cursor?.last_item_date;
    const cutoffDate = cursor?.last_item_date ? new Date(cursor.last_item_date) : null;
    
    logger.info(`Starting App Store scrape (mode: ${isIncremental ? 'incremental' : 'full'})`);
    if (cutoffDate) logger.info(`Fetching reviews newer than: ${cutoffDate.toISOString()}`);

    const logId = logScrapeStart(this.platform);
    
    try {
      const appId = config.appstoreAppId;
      
      if (!process.env.APPSTORE_APP_ID || !appId) {
        throw new Error('App Store app ID not configured. Set APPSTORE_APP_ID in .env');
      }
      
      logger.info(`Fetching reviews for App ID: ${appId}`);
      
      const allReviews = new Map<string, AppStoreReview>();
      
      // First: Fetch from RSS feeds (all countries, all pages)
      logger.info('Phase 1: RSS Feed scraping...');
      const rssReviews = await this.fetchFromRSSFeeds(appId, cutoffDate);
      for (const [id, review] of rssReviews) {
        allReviews.set(id, review);
      }
      logger.info(`RSS fetched: ${rssReviews.size} reviews`);
      
      // Second: Browser scraping
      // In incremental mode, skip browser if we found NO new reviews in RSS (likely no activity)
      // Or limit browser scraping significantly
      const shouldRunBrowser = !isIncremental || rssReviews.size > 0 || !cursor || (Date.now() - new Date(cursor.last_scraped_at).getTime() > 24 * 60 * 60 * 1000); // Run at least once every 24h
      
      if (shouldRunBrowser) {
        logger.info('Phase 2: Browser scraping...');
        const browserReviews = await this.fetchViaBrowser(appId, cutoffDate);
        for (const [id, review] of browserReviews) {
          if (!allReviews.has(id)) {
            allReviews.set(id, review);
          }
        }
        logger.info(`Browser fetched: ${browserReviews.size} additional reviews`);
      } else {
        logger.info('Skipping browser phase (incremental mode, no new RSS activity)');
      }
      
      logger.info(`Total unique reviews: ${allReviews.size}`);
      
      // Convert to Review format
      const reviews: Review[] = [];
      let newestDateFound: Date | null = null;
      let recentIds: string[] = [];

      for (const review of allReviews.values()) {
        const sentiment = analyzeSentiment(review.content || review.title);
        const normalizedDate = this.normalizeDate(review.updated);
        
        // Track newest date for cursor
        const reviewDate = new Date(normalizedDate);
        if (!newestDateFound || reviewDate > newestDateFound) {
          newestDateFound = reviewDate;
        }

        reviews.push({
          platform_id: PLATFORMS.appstore,
          external_id: review.id,
          author: review.author,
          rating: review.rating,
          title: review.title,
          content: review.content,
          app_version: review.version || null,
          helpful_count: 0,
          developer_reply: null,
          sentiment_score: sentiment.score,
          sentiment_label: sentiment.label,
          review_date: normalizedDate,
        });
      }
      
      // Save to database
      newItems = insertReviews(reviews);
      
      // Update cursor
      if (newestDateFound) {
        // Only update if newer than previous
        if (!cutoffDate || newestDateFound > cutoffDate) {
          // Keep top 100 IDs for safety
          recentIds = reviews
            .sort((a, b) => new Date(b.review_date).getTime() - new Date(a.review_date).getTime())
            .slice(0, 100)
            .map(r => r.external_id);
            
          updateScrapeCursor(this.platform, newestDateFound.toISOString(), recentIds);
          logger.info(`Updated cursor to: ${newestDateFound.toISOString()}`);
        }
      } else if (!cursor && reviews.length > 0) {
          // First run partial
          updateScrapeCursor(this.platform, new Date().toISOString());
      }
      
      logScrapeEnd(logId, 'success', reviews.length, newItems);
      logger.info(`App Store scrape complete: ${reviews.length} found, ${newItems} new`);
      
      return { items: reviews, newItems, errors };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      logScrapeEnd(logId, 'failed', 0, 0, errorMessage);
      logger.error(`App Store scrape failed: ${errorMessage}`);
      return { items: [], newItems: 0, errors };
    } finally {
      await this.cleanup();
    }
  }
  
  private async fetchFromRSSFeeds(appId: string, cutoffDate: Date | null): Promise<Map<string, AppStoreReview>> {
    const allReviews = new Map<string, AppStoreReview>();
    
    logger.info(`Scanning ${this.countries.length} countries via RSS...`);
    
    for (const country of this.countries) {
      try {
        const countryReviews = await this.fetchAllPagesForCountry(appId, country, cutoffDate);
        
        if (countryReviews.length > 0) {
          logger.info(`${country.toUpperCase()}: ${countryReviews.length} reviews from RSS`);
          
          for (const review of countryReviews) {
            if (!allReviews.has(review.id)) {
              allReviews.set(review.id, review);
            }
          }
        }
        
        await randomDelay(200, 400);
        
      } catch (error) {
        logger.debug(`RSS error for ${country}: ${error}`);
      }
    }
    
    return allReviews;
  }
  
  private async fetchAllPagesForCountry(appId: string, country: string, cutoffDate: Date | null): Promise<AppStoreReview[]> {
    const reviews: AppStoreReview[] = [];
    const maxPages = 10;
    
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortBy=mostRecent/json`;
        
        const response = await withRetry(
          async () => {
            await rateLimit(this.platform);
            return fetch(url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json',
              },
            });
          },
          { maxRetries: 2, baseDelay: 1000, platform: this.platform }
        );
        
        if (!response.ok) break;
        
        const data = await response.json();
        
        if (!data.feed || !data.feed.entry) break;
        
        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
        
        let pageReviewCount = 0;
        let skipCount = 0;
        
        for (const entry of entries) {
          if (entry['im:name']) continue;
          
          const updated = entry.updated?.label || new Date().toISOString();
          
          // Check cutoff
          if (cutoffDate && new Date(updated) <= cutoffDate) {
            skipCount++;
            continue;
          }
          
          const reviewId = entry.id?.label || `as-${country}-${Date.now()}-${Math.random()}`;
          
          reviews.push({
            id: reviewId,
            author: entry.author?.name?.label || 'Anonymous',
            rating: parseInt(entry['im:rating']?.label) || 0,
            title: entry.title?.label || '',
            content: entry.content?.label || '',
            version: entry['im:version']?.label || '',
            updated: updated,
            country: country.toUpperCase(),
          });
          
          pageReviewCount++;
        }
        
        if (pageReviewCount === 0 && skipCount > 0) {
            // All reviews on this page were skipped (older than cutoff)
            // Stop pagination for this country
            break;
        }

        if (pageReviewCount === 0) break;
        
        await randomDelay(150, 300);
        
      } catch (error) {
        break;
      }
    }
    
    return reviews;
  }
  
  private async fetchViaBrowser(appId: string, cutoffDate: Date | null): Promise<Map<string, AppStoreReview>> {
    const allReviews = new Map<string, AppStoreReview>();
    
    // Browser scrape from key countries with most users
    const keyCountries = ['in', 'us', 'gb'];
    
    try {
      logger.info('Browser: Starting Playwright scraper for App Store...');
      
      this.context = await createStealthContext({ platform: 'appstore' });
      this.page = await this.context.newPage();
      
      for (const country of keyCountries) {
        try {
          const url = `https://apps.apple.com/${country}/app/id${appId}`;
          logger.info(`Browser: Scraping ${country.toUpperCase()}...`);
          
          await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
          await randomDelay(2000, 3000);
          
          // Scroll to reviews section
          await this.page.evaluate(() => {
            const section = document.querySelector('#ratings-and-reviews');
            if (section) section.scrollIntoView();
          });
          
          await randomDelay(1000, 2000);
          
          // Try to click "See All" for reviews
          try {
            const seeAllLink = await this.page.$('a[href*="see-all/reviews"]');
            if (seeAllLink) {
              await seeAllLink.click();
              await randomDelay(2000, 3000);
              
              // Scroll through reviews
              let previousCount = 0;
              let noNewCount = 0;
              const maxScrolls = cutoffDate ? 25 : 50; // Less scrolling in incremental mode
              
              for (let i = 0; i < maxScrolls; i++) {
                const reviews = await this.extractReviewsFromPage(country);
                let newInBatch = 0;
                
                for (const review of reviews) {
                  // Skip old
                  if (cutoffDate && new Date(review.updated) <= cutoffDate) continue;

                  if (!allReviews.has(review.id)) {
                    allReviews.set(review.id, review);
                    newInBatch++;
                  }
                }
                
                if (newInBatch === 0 || allReviews.size === previousCount) {
                  noNewCount++;
                  if (noNewCount >= 3) break;
                } else {
                  noNewCount = 0;
                }
                
                previousCount = allReviews.size;
                
                await this.page.evaluate(() => window.scrollBy(0, 800));
                await randomDelay(500, 1000);
              }
            }
          } catch (e) {
            logger.debug(`Browser navigation error for ${country}: ${e}`);
          }
          
          // Also extract reviews from main page
          const mainPageReviews = await this.extractReviewsFromPage(country);
          for (const review of mainPageReviews) {
            if (!allReviews.has(review.id)) {
              allReviews.set(review.id, review);
            }
          }
          
        } catch (error) {
          logger.debug(`Browser error for ${country}: ${error}`);
        }
      }
      
    } catch (error) {
      logger.warn(`Browser scraper failed: ${error}`);
    }
    
    return allReviews;
  }
  
  private async extractReviewsFromPage(country: string): Promise<AppStoreReview[]> {
    const reviews: AppStoreReview[] = [];
    
    if (!this.page) return reviews;
    
    try {
      // Extract reviews from the page
      const reviewData = await this.page.evaluate(() => {
        const reviewCards = document.querySelectorAll('.we-customer-review');
        const results: any[] = [];
        
        reviewCards.forEach((card, index) => {
          try {
            const author = card.querySelector('.we-customer-review__user')?.textContent?.trim() || 'Anonymous';
            const title = card.querySelector('.we-customer-review__title')?.textContent?.trim() || '';
            const content = card.querySelector('.we-customer-review__body')?.textContent?.trim() || '';
            const date = card.querySelector('.we-customer-review__date')?.textContent?.trim() || '';
            
            // Rating from stars
            const stars = card.querySelectorAll('.we-star-rating-stars-outlines use[href="#star-full"]');
            const rating = stars.length || 0;
            
            results.push({
              author,
              title,
              content,
              date,
              rating,
            });
          } catch (e) {}
        });
        
        return results;
      });
      
      for (const data of reviewData) {
        const stableId = this.hashReviewId(country, data.author, data.title, data.content, data.date, data.rating);
        reviews.push({
          id: stableId,
          author: data.author,
          rating: data.rating,
          title: data.title,
          content: data.content,
          version: '',
          updated: data.date || new Date().toISOString(),
          country: country.toUpperCase(),
        });
      }
      
    } catch (error) {
      logger.debug(`Extract error: ${error}`);
    }
    
    return reviews;
  }

  private hashReviewId(
    country: string,
    author: string,
    title: string,
    content: string,
    date: string,
    rating: number
  ): string {
    const raw = [country, author, title, content, date, String(rating)].join('|').toLowerCase();
    return `browser-${createHash('sha1').update(raw).digest('hex')}`;
  }
  
  private async cleanup(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    await closeBrowser();
  }

  private normalizeDate(input: string): string {
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
      return new Date().toISOString();
    }
    return parsed.toISOString();
  }
}
