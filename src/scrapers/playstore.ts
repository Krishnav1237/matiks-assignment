import { Page, BrowserContext } from 'playwright';
import gplay from 'google-play-scraper';
import { createStealthContext, closeBrowser } from '../core/browser.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { Review, insertReviews, PLATFORMS, logScrapeStart, logScrapeEnd, getScrapeCursor, getRecentExternalIds, updateScrapeCursor } from '../db/queries.js';
import { analyzeSentiment } from '../pipeline/sentiment.js';
import { randomDelay, humanScroll } from '../core/humanize.js';
import { rateLimit, withRetry } from '../core/rateLimit.js';

interface PlayStoreReviewData {
  id: string;
  userName: string;
  userImage?: string;
  date: string;
  score: number;
  text: string;
  thumbsUp: number;
  version?: string;
  replyText?: string;
  replyDate?: string;
}

export class PlayStoreScraper {
  private platform = 'playstore' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  
  async run(): Promise<{ items: Review[]; newItems: number; errors: string[] }> {
    const errors: string[] = [];
    let newItems = 0;
    
    // Check if we have scraped before
    const cursor = getScrapeCursor('playstore');
    const isIncremental = !!cursor;
    
    // Get known IDs to avoid re-processing
    const knownIds = new Set(getRecentExternalIds('playstore', 1000));
    
    logger.info(`Starting Play Store scrape (mode: ${isIncremental ? 'incremental' : 'full'})`);
    if (isIncremental) logger.info(`Loaded ${knownIds.size} known IDs for deduplication`);
    
    const logId = logScrapeStart(this.platform);
    
    try {
      const appId = config.playstoreAppId;
      
      if (!process.env.PLAYSTORE_APP_ID || !appId) {
        throw new Error('Play Store app ID not configured. Set PLAYSTORE_APP_ID in .env');
      }
      
      logger.info(`Fetching reviews for: ${appId}`);
      
      // First, try API-based scraping (faster, gets most reviews)
      const apiReviews = await this.fetchViaAPI(appId, knownIds);
      logger.info(`API fetched: ${apiReviews.size} new reviews`);
      
      // Then, enhance with browser scraping (skip if we got nothing new from API in incremental mode)
      const shouldRunBrowser = !isIncremental || apiReviews.size > 0 || !cursor || (Date.now() - new Date(cursor.last_scraped_at).getTime() > 24 * 60 * 60 * 1000);
      let browserReviews = new Map<string, PlayStoreReviewData>();
      
      if (shouldRunBrowser) {
        logger.info('Enhancing with browser scraping...');
        browserReviews = await this.fetchViaBrowser(appId, knownIds, isIncremental);
        logger.info(`Browser fetched: ${browserReviews.size} new reviews`);
      } else {
        logger.info('Skipping browser phase (incremental mode, no new API activity)');
      }
      
      // Merge results (API reviews take precedence as they have more metadata)
      const allReviews = new Map<string, PlayStoreReviewData>();
      
      // Add browser reviews first
      for (const [id, review] of browserReviews) {
        allReviews.set(id, review);
      }
      
      // Override with API reviews (more complete data)
      for (const [id, review] of apiReviews) {
        allReviews.set(id, review);
      }
      
      logger.info(`Total unique new reviews: ${allReviews.size}`);
      
      // Convert to Review format
      const reviews: Review[] = [];
      let newestDateFound: Date | null = null;
      
      for (const review of allReviews.values()) {
        const sentiment = analyzeSentiment(review.text || '');
        
        // Track newest date if valid
        if (review.date) {
            const rDate = new Date(review.date);
            if (!Number.isNaN(rDate.getTime())) {
                if (!newestDateFound || rDate > newestDateFound) {
                    newestDateFound = rDate;
                }
            }
        }
        
        reviews.push({
          platform_id: PLATFORMS.playstore,
          external_id: review.id,
          author: review.userName || 'Anonymous',
          rating: review.score || 0,
          title: null,
          content: review.text || '',
          app_version: review.version || null,
          helpful_count: review.thumbsUp || 0,
          developer_reply: review.replyText || null,
          sentiment_score: sentiment.score,
          sentiment_label: sentiment.label,
          review_date: review.date ? new Date(review.date).toISOString() : new Date().toISOString(),
        });
      }
      
      // Save to database
      if (reviews.length > 0) {
        newItems = insertReviews(reviews);
        
        // Update cursor
        const recentIds = reviews
           .sort((a, b) => new Date(b.review_date).getTime() - new Date(a.review_date).getTime())
           .slice(0, 50)
           .map(r => r.external_id);
           
        updateScrapeCursor(this.platform, newestDateFound?.toISOString(), recentIds);
      } else if (!cursor) {
        updateScrapeCursor(this.platform, new Date().toISOString());
      }
      
      logScrapeEnd(logId, 'success', reviews.length, newItems);
      logger.info(`Play Store scrape complete: ${reviews.length} found, ${newItems} new`);
      
      return { items: reviews, newItems, errors };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(errorMessage);
      logScrapeEnd(logId, 'failed', 0, 0, errorMessage);
      logger.error(`Play Store scrape failed: ${errorMessage}`);
      return { items: [], newItems: 0, errors };
    } finally {
      await this.cleanup();
    }
  }
  
  private async fetchViaAPI(appId: string, knownIds: Set<string>): Promise<Map<string, PlayStoreReviewData>> {
    const allReviews = new Map<string, PlayStoreReviewData>();
    
    // Sort by NEWEST first for incremental efficiency
    const sortMethods = [
      { sort: gplay.sort.NEWEST, name: 'NEWEST' },
      { sort: gplay.sort.RATING, name: 'RATING' },
      { sort: gplay.sort.HELPFULNESS, name: 'HELPFULNESS' },
    ];
    
    for (const { sort, name } of sortMethods) {
      logger.debug(`API: Fetching ${name} reviews...`);
      
      let token: string | null = null;
      let pageCount = 0;
      const maxPages = 50; 
      let consecutiveKnownIds = 0;
      
      while (pageCount < maxPages) {
        try {
          const options: any = {
            appId,
            sort,
            num: 150,
            paginate: true,
          };
          
          if (token) {
            options.nextPaginationToken = token;
          }
          
          const result = await withRetry(
            async () => {
              await rateLimit(this.platform);
              return gplay.reviews(options);
            },
            { maxRetries: 2, baseDelay: 1000, platform: this.platform }
          );
          const reviewsData = (result as any).data || result;
          
          if (!Array.isArray(reviewsData) || reviewsData.length === 0) {
            break;
          }
          
          let newInBatch = 0;
          
          for (const review of reviewsData) {
            if (review.id) {
               if (knownIds.has(review.id)) {
                  consecutiveKnownIds++;
               } else if (!allReviews.has(review.id)) {
                  allReviews.set(review.id, {
                    id: review.id,
                    userName: review.userName || 'Anonymous',
                    userImage: review.userImage,
                    date: review.date,
                    score: review.score || 0,
                    text: review.text || '',
                    thumbsUp: review.thumbsUp || 0,
                    version: review.version,
                    replyText: review.replyText,
                    replyDate: review.replyDate,
                  });
                  newInBatch++;
                  consecutiveKnownIds = 0;
               }
            }
          }
          
          // Stop pagination if we hit too many known IDs in NEWEST sort mode
          if (sort === gplay.sort.NEWEST && consecutiveKnownIds > 20) {
            logger.debug('Hit known reviews threshold, stopping pagination for NEWEST');
            break;
          }
          
          token = (result as any).nextPaginationToken || null;
          pageCount++;
          
          if (!token) break;
          
          await randomDelay(500, 1000);
          
        } catch (error) {
          logger.debug(`API error on page ${pageCount + 1}: ${error}`);
          break;
        }
      }
      
      // If we got plenty from NEWEST, maybe skip others in incremental mode?
      // For now, let's keep it safe and check others briefly
    }
    
    return allReviews;
  }
  
  private async fetchViaBrowser(appId: string, knownIds: Set<string>, isIncremental: boolean): Promise<Map<string, PlayStoreReviewData>> {
    const allReviews = new Map<string, PlayStoreReviewData>();
    
    try {
      logger.info('Browser: Starting Playwright scraper...');
      
      this.context = await createStealthContext({ platform: 'playstore' });
      this.page = await this.context.newPage();
      
      // Navigate to app page
      const url = `https://play.google.com/store/apps/details?id=${appId}&hl=en`;
      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      
      await randomDelay(2000, 3000);
      
      // Click "See all reviews" to open the reviews modal
      try {
        const seeAllButton = await this.page.$('text="See all reviews"');
        if (seeAllButton) {
          await seeAllButton.click();
          await randomDelay(2000, 3000);
          
          // Scroll through reviews in the modal
          let previousCount = 0;
          let noNewReviewsCount = 0;
          // In incremental mode, reduce scrolling significantly (15 scrolls vs 100)
          const maxScrollAttempts = isIncremental ? 15 : 100;
          
          for (let i = 0; i < maxScrollAttempts; i++) {
            // Extract visible reviews
            const reviews = await this.extractReviewsFromPage();
            let newInBatch = 0;
            
            for (const review of reviews) {
              if (review.id && !knownIds.has(review.id) && !allReviews.has(review.id)) {
                allReviews.set(review.id, review);
                newInBatch++;
              }
            }
            
            logger.debug(`Browser scroll ${i + 1}: ${newInBatch} NEW reviews collected`);
            
            // Check if we got new reviews
            if (newInBatch === 0) {
              noNewReviewsCount++;
              if (noNewReviewsCount >= 3) {
                logger.debug('No new reviews after 3 scrolls, stopping');
                break;
              }
            } else {
              noNewReviewsCount = 0;
            }
            
            previousCount = allReviews.size;
            
            // Scroll down in the modal
            await this.page.evaluate(() => {
              const modal = document.querySelector('[role="dialog"]');
              if (modal) {
                modal.scrollTop = modal.scrollHeight;
              } else {
                window.scrollBy(0, 1000);
              }
            });
            
            await randomDelay(1000, 2000);
          }
        }
      } catch (error) {
        logger.debug(`Browser scraping error: ${error}`);
      }
      
    } catch (error) {
      logger.warn(`Browser scraper failed: ${error}`);
    }
    
    return allReviews;
  }
  
  private async extractReviewsFromPage(): Promise<PlayStoreReviewData[]> {
    const reviews: PlayStoreReviewData[] = [];
    
    if (!this.page) return reviews;
    
    try {
      const reviewElements = await this.page.$$('[data-review-id]');
      
      for (const element of reviewElements) {
        try {
          const reviewId = await element.getAttribute('data-review-id');
          if (!reviewId) continue;
          
          const userName = await element.$eval('[class*="X43Kjb"]', el => el.textContent || '').catch(() => 'Anonymous');
          
          // Extract rating from aria-label like "Rated 5 stars out of five stars"
          const ratingText = await element.$eval('[role="img"]', el => el.getAttribute('aria-label') || '').catch(() => '');
          const ratingMatch = ratingText.match(/Rated (\d)/);
          const score = ratingMatch ? parseInt(ratingMatch[1]) : 0;
          
          // Date
          const date = await element.$eval('[class*="bp9Aid"]', el => el.textContent || '').catch(() => '');
          
          // Review text
          const text = await element.$eval('[class*="h3YV2d"]', el => el.textContent || '').catch(() => '');
          
          // Helpful count
          const helpfulText = await element.$eval('[class*="AJTPZc"]', el => el.textContent || '0').catch(() => '0');
          const thumbsUp = parseInt(helpfulText.replace(/[^0-9]/g, '')) || 0;
          
          // Version (if available)
          const version = await element.$eval('[class*="sPPcBf"]', el => {
            const text = el.textContent || '';
            return text.replace('Version', '').trim();
          }).catch(() => undefined);
          
          reviews.push({
            id: reviewId,
            userName,
            date,
            score,
            text,
            thumbsUp,
            version,
          });
          
        } catch (e) {
          // Skip malformed reviews
        }
      }
    } catch (error) {
      logger.debug(`Extract error: ${error}`);
    }
    
    return reviews;
  }
  
  private async cleanup(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    await closeBrowser();
  }
}
