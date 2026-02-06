/**
 * PRODUCTION-GRADE REDDIT SCRAPER
 * ================================
 * Exhaustive, bulletproof scraper for capturing ALL Matiks mentions on Reddit.
 * 
 * Features:
 * - Token bucket rate limiter with exponential backoff
 * - Multiple API endpoints (reddit.com, old.reddit.com)
 * - Exhaustive search coverage (100+ search combinations)
 * - Full pagination (ALL pages until exhausted)
 * - Subreddit-specific searches (30+ subreddits)
 * - Comment search with pagination
 * - Historical archive integration (Pushshift)
 * - Browser fallback for visual verification
 * - Incremental saves to prevent data loss
 * - Comprehensive deduplication
 */

import { logger } from '../core/logger.js';
import { config } from '../config.js';
import { Mention, insertMentions, PLATFORMS, logScrapeStart, logScrapeEnd, getScrapeCursor, updateScrapeCursor } from '../db/queries.js';
import { analyzeSentiment } from '../pipeline/sentiment.js';
import { getBrowser, closeBrowser } from '../core/browser.js';
import { matchesBrand, matchesBrandBalanced, getBrandAnchors } from '../core/brandFilter.js';
import type { Page } from 'playwright';

// ============================================================================
// TYPES
// ============================================================================

interface RedditPost {
  id: string;
  name: string;
  title: string;
  author: string;
  subreddit: string;
  permalink: string;
  selftext: string;
  score: number;
  num_comments: number;
  created_utc: number;
  url?: string;
  preview?: { images?: Array<{ source: { url: string } }> };
}

interface RedditComment {
  id: string;
  name: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  permalink: string;
  subreddit: string;
}

interface ScrapeStats {
  apiCalls: number;
  rateLimitHits: number;
  postsFound: number;
  commentsFound: number;
  duplicatesSkipped: number;
  filteredOut: number;
  saved: number;
}

// ============================================================================
// RATE LIMITER - Token Bucket with Exponential Backoff
// ============================================================================

class ProductionRateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number;
  private backoffMultiplier: number = 1;
  private consecutiveErrors: number = 0;

  constructor(requestsPerMinute: number = 25) {
    this.maxTokens = Math.ceil(requestsPerMinute / 2); // Burst capacity
    this.tokens = this.maxTokens;
    this.refillRate = requestsPerMinute / 60; // tokens per second
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refillTokens();

    if (this.tokens < 1) {
      const waitTime = Math.ceil((1 / this.refillRate) * 1000 * this.backoffMultiplier);
      await this.sleep(waitTime);
      this.refillTokens();
    }

    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  onSuccess(): void {
    this.consecutiveErrors = 0;
    this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.9); // Slowly reduce backoff
  }

  onRateLimit(): void {
    this.consecutiveErrors++;
    this.backoffMultiplier = Math.min(10, this.backoffMultiplier * 2);
    this.tokens = 0; // Drain tokens on rate limit
  }

  getBackoffTime(): number {
    return Math.min(30000, 2000 * Math.pow(2, this.consecutiveErrors));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// MAIN SCRAPER CLASS
// ============================================================================

export class RedditScraper {
  private platform = 'reddit' as const;
  private seenIds = new Set<string>();
  private seenContent = new Set<string>(); // For content-based dedup
  private stats: ScrapeStats = {
    apiCalls: 0,
    rateLimitHits: 0,
    postsFound: 0,
    commentsFound: 0,
    duplicatesSkipped: 0,
    filteredOut: 0,
    saved: 0,
  };

  private rateLimiter = new ProductionRateLimiter(25); // Conservative: 25 req/min
  private startTime = 0;
  private maxDuration = 10 * 60 * 1000; // 10 minutes max

  // User agents for rotation
  private userAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  ];

  // Exclusion filters
  private readonly excludeSubreddits = new Set([
    'philippines', 'phr4r', 'casualph', 'alasjuicy', 'phinvest', 'phcareers',
    'phgonewild', 'phclassifieds', 'offmychestph', 'phremix', 'phmoneysaving'
  ]);
  
  private readonly brandSubreddits = new Set(
    (config.brandSubreddits || []).map(sub => sub.toLowerCase()).filter(Boolean)
  );

  private readonly excludePatterns = [
    // Filipino language patterns
    /\b(pinoy|pinay|tagalog|pilipinas|philippines|filipino|filipina)\b/i,
    /\b(kuya|ate|bata|galing|sarap|talaga|kasi|parang|yung|naman|lang|dito|tayo|siya|basta|orens|pogi)\b/i,
    /\b(pupcet|pupc|pup|ust|dlsu|admu|ateneo|la\s*salle)\b/i, // Filipino universities
    
    // Basketball/sports slang
    /\bmatik\s*(dribble|shoot|shot|pass|ball|basketball|hoop|three|score)\b/i,
    
    // Tattoo artists (Matt Matik, etc.)
    /\b(tattoo|tattooist|inked|ink|ritual\s*tattoo|matt\s*matik)\b/i,
    
    // Gaming (Counter-Strike, etc.) - not the Matiks app
    /\b(counter[\-\s]?strike|csgo|cs2|hunger\s*games\s*server|thorius)\b/i,
    
    // Japanese/anime names containing "matik"
    /\bmatika(ne|ru|ko|mi)|fukuki|lunaticmons\b/i,
    
    // Dreams/horoscope content
    /\b(dream\s*school|horoscope|zodiac|astrology|superstition)\b/i,
  ];
  
  // Keywords that indicate Matiks app context (used only when brandStrict=false)
  private readonly contextKeywords = [
    'app', 'game', 'math', 'mental', 'brain', 'puzzle', 'duel', 'streak',
    'android', 'ios', 'download', 'play store', 'app store', 'mobile',
    'arithmetic', 'calculation', 'speed', 'training', 'challenge', 'leaderboard',
    'score', 'level', 'addicted', 'playing', 'installed', 'tried', 'recommended'
  ];

  // ============================================================================
  // MAIN RUN METHOD
  // ============================================================================

  async run(): Promise<{ items: Mention[]; newItems: number; errors: string[] }> {
    const errors: string[] = [];
    this.startTime = Date.now();
    this.seenIds.clear();
    this.seenContent.clear();
    this.stats = { apiCalls: 0, rateLimitHits: 0, postsFound: 0, commentsFound: 0, duplicatesSkipped: 0, filteredOut: 0, saved: 0 };

    logger.info('========================================');
    // Check if we have scraped before
    const cursor = getScrapeCursor('reddit');
    const isIncremental = !!cursor;
    
    // Adjust limits based on mode
    this.maxDuration = isIncremental ? 5 * 60 * 1000 : 10 * 60 * 1000; // 5 mins for incremental

    logger.info(`Starting Reddit scrape (mode: ${isIncremental ? 'incremental' : 'full'})`);
    logger.info(`Max Duration: ${this.maxDuration / 1000 / 60} minutes`);
    logger.info('Rate Limit: 25 req/min with exponential backoff');

    const logId = logScrapeStart(this.platform);
    const buffer: Mention[] = [];

    try {
      // =====================================================================
      // PHASE 0: BRAND SUBREDDIT LISTINGS (ALL POSTS + COMMENTS)
      // =====================================================================
      await this.phase0_BrandSubredditListings(buffer);

      // =====================================================================
      // PHASE 1: EXHAUSTIVE API SEARCH
      // =====================================================================
      await this.phase1_ExhaustiveApiSearch(buffer, isIncremental);

      // =====================================================================
      // PHASE 2: SUBREDDIT-SPECIFIC SEARCHES
      // =====================================================================
      await this.phase2_SubredditSearches(buffer);

      // =====================================================================
      // PHASE 3: COMMENT SEARCH
      // =====================================================================
      await this.phase3_CommentSearch(buffer);

      // =====================================================================
      // PHASE 4: HISTORICAL ARCHIVES
      // =====================================================================
      await this.phase4_HistoricalArchives(buffer, isIncremental);

      // =====================================================================
      // PHASE 5: BROWSER VERIFICATION
      // =====================================================================
      await this.phase5_BrowserVerification(buffer);

      // Final flush
      this.flushBuffer(buffer);

      // Log final stats
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
      logger.info('========================================');
      logger.info('SCRAPE COMPLETE - FINAL STATS');
      logger.info('========================================');
      logger.info(`Duration: ${elapsed}s`);
      logger.info(`API Calls: ${this.stats.apiCalls}`);
      logger.info(`Rate Limit Hits: ${this.stats.rateLimitHits}`);
      logger.info(`Posts Found: ${this.stats.postsFound}`);
      logger.info(`Comments Found: ${this.stats.commentsFound}`);
      logger.info(`Duplicates Skipped: ${this.stats.duplicatesSkipped}`);
      logger.info(`Filtered Out: ${this.stats.filteredOut}`);
      logger.info(`SAVED TO DB: ${this.stats.saved}`);

      // Update cursor if successful
      if (this.stats.saved > 0 || !cursor) {
        updateScrapeCursor(this.platform, new Date().toISOString());
      }
      
      logScrapeEnd(logId, 'success', this.stats.postsFound + this.stats.commentsFound, this.stats.saved);
      return { items: [], newItems: this.stats.saved, errors };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`FATAL ERROR: ${msg}`);
      errors.push(msg);
      
      // Still save whatever we have
      this.flushBuffer(buffer);
      
      logScrapeEnd(logId, 'failed', this.stats.postsFound + this.stats.commentsFound, this.stats.saved, msg);
      return { items: [], newItems: this.stats.saved, errors };
    }
  }

  // ============================================================================
  // PHASE 0: BRAND SUBREDDIT LISTINGS
  // ============================================================================

  private async phase0_BrandSubredditListings(buffer: Mention[]): Promise<void> {
    if (this.isTimeUp()) return;
    if (this.brandSubreddits.size === 0) return;

    logger.info('');
    logger.info('PHASE 0: Brand Subreddit Listings');
    logger.info('---------------------------------');

    for (const sub of this.brandSubreddits) {
      if (this.isTimeUp()) break;
      logger.info(`  Fetching ALL posts in r/${sub}`);
      await this.fetchSubredditListings(sub, 'new', buffer);
      await this.fetchSubredditListings(sub, 'hot', buffer);
      await this.fetchSubredditComments(sub, buffer);

      if (buffer.length >= 25) {
        this.flushBuffer(buffer);
      }
    }
  }

  // ============================================================================
  // PHASE 1: EXHAUSTIVE API SEARCH
  // ============================================================================

  private async phase1_ExhaustiveApiSearch(buffer: Mention[], isIncremental = false): Promise<void> {
    if (this.isTimeUp()) return;
    
    logger.info('');
    logger.info('PHASE 1: Exhaustive API Search');
    logger.info('------------------------------');

    // All search terms to try
    const baseTerms = config.searchTerms.length > 0 ? config.searchTerms : ['matiks'];
    const brandAnchors = getBrandAnchors();
    const searchTerms = Array.from(new Set([
      ...baseTerms,
      ...brandAnchors,
      '"matiks"',
      '"matiks app"',
      '"matiks game"',
      '"matiks.in"',
      'matiks',
      'matiks app',
      'matiks game',
      'matiks.in',
      'matiks math',
      'matiks mental math',
      'matiks brain',
      'matiks brain training',
      'matiks puzzle',
      'matiks duel',
      'matiks duels',
      'matiks streak',
      'matiks challenge',
      'matiks leaderboard',
      'matiks android',
      'matiks ios',
      'matiks iphone',
      'matiks download',
      'matiks play store',
      'matiks app store',
      'matiks mobile',
      'matik app',
      'matik game',
      'matics app',
    ].filter(Boolean)));

    const sortOptions = isIncremental 
      ? ['new', 'relevance'] 
      : ['relevance', 'new', 'top', 'comments'];
      
    const timeFilters = isIncremental
      ? ['day', 'week']
      : ['all', 'year', 'month', 'week', 'day'];

    let termCount = 0;
    for (const term of searchTerms) {
      if (this.isTimeUp()) break;
      
      termCount++;
      logger.info(`  [${termCount}/${searchTerms.length}] "${term}"`);

      for (const sort of sortOptions) {
        for (const time of timeFilters) {
          if (this.isTimeUp()) break;
          
          // Fetch ALL pages for this combination
          await this.fetchAllPagesForSearch(term, sort, time, buffer);
        }
      }

      // Save progress after each term
      if (buffer.length >= 25) {
        this.flushBuffer(buffer);
      }
    }
  }

  // ============================================================================
  // PHASE 2: SUBREDDIT SEARCHES
  // ============================================================================

  private async phase2_SubredditSearches(buffer: Mention[]): Promise<void> {
    if (this.isTimeUp()) return;

    logger.info('');
    logger.info('PHASE 2: Subreddit-Specific Searches');
    logger.info('------------------------------------');

    const subreddits = [
      // App stores
      'androidapps', 'iosapps', 'AppHookup', 'apps', 'apphookup',
      
      // Gaming
      'androidgaming', 'iosgaming', 'MobileGaming', 'IndieGaming', 'incremental_games',
      'gamedev', 'playmygame', 'gaming',
      
      // Education
      'math', 'learnmath', 'matheducation', 'mathematics', 'askmath',
      'education', 'edtech', 'homeschool', 'teachers',
      
      // Brain training
      'braingames', 'puzzles', 'braintraining', 'mentalmath',
      'cognitivescience', 'Nootropics',
      
      // Productivity
      'productivity', 'selfimprovement', 'getdisciplined', 'DecidingToBeBetter',
      
      // Regional (India focus since matiks.in)
      'india', 'indiasocial', 'IndianGaming', 'developersIndia',
      'bangalore', 'mumbai', 'delhi', 'hyderabad', 'chennai',
      
      // Tech
      'Android', 'iphone', 'apple', 'google',
    ];

    let subCount = 0;
    for (const sub of subreddits) {
      if (this.isTimeUp()) break;
      
      subCount++;
      const found = await this.searchSubreddit(sub, buffer);
      if (found > 0) {
        logger.info(`  [${subCount}/${subreddits.length}] r/${sub}: +${found}`);
      }

      // Save progress periodically
      if (buffer.length >= 25) {
        this.flushBuffer(buffer);
      }
    }
  }

  // ============================================================================
  // PHASE 3: COMMENT SEARCH
  // ============================================================================

  private async phase3_CommentSearch(buffer: Mention[]): Promise<void> {
    if (this.isTimeUp()) return;

    logger.info('');
    logger.info('PHASE 3: Comment Search');
    logger.info('-----------------------');

    const commentTerms = Array.from(new Set([
      ...getBrandAnchors(),
      'matiks',
      '"matiks"',
      'matiks app',
      'matiks.in',
      'matiks game',
      'matiks math',
    ].filter(Boolean)));

    for (const term of commentTerms) {
      if (this.isTimeUp()) break;

      logger.info(`  Searching comments for: "${term}"`);
      await this.searchComments(term, buffer);
    }

    this.flushBuffer(buffer);
  }

  // ============================================================================
  // PHASE 4: HISTORICAL ARCHIVES
  // ============================================================================

  private async phase4_HistoricalArchives(buffer: Mention[], isIncremental = false): Promise<void> {
    if (this.isTimeUp()) return;
    
    if (isIncremental) {
      logger.info('');
      logger.info('PHASE 4: Historical Archives (Skipped for incremental run)');
      logger.info('----------------------------------------');
      return;
    }

    logger.info('');
    logger.info('PHASE 4: Historical Archives (Pushshift)');
    logger.info('----------------------------------------');

    const brandAnchors = getBrandAnchors();
    const archiveEndpoints = [
      // Submissions
      'https://api.pullpush.io/reddit/search/submission/?q=matiks&size=500',
      'https://api.pullpush.io/reddit/search/submission/?q="matiks app"&size=200',
      'https://api.pullpush.io/reddit/search/submission/?q=matiks.in&size=200',
      'https://api.pullpush.io/reddit/search/submission/?q="matiks game"&size=200',
      
      // Comments
      'https://api.pullpush.io/reddit/search/comment/?q=matiks&size=500',
      'https://api.pullpush.io/reddit/search/comment/?q="matiks app"&size=200',
      ...brandAnchors.map(anchor => `https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(anchor)}&size=200`),
      ...brandAnchors.map(anchor => `https://api.pullpush.io/reddit/search/comment/?q=${encodeURIComponent(anchor)}&size=200`),
    ];

    for (const url of archiveEndpoints) {
      if (this.isTimeUp()) break;

      try {
        logger.info(`  Fetching: ${url.split('?')[0]}...`);
        
        const response = await fetch(url, {
          headers: { 'User-Agent': this.getRandomUserAgent() },
        });

        if (response.ok) {
          const data = await response.json();
          const items = data.data || [];
          let added = 0;

          for (const item of items) {
            if (item.title) {
              // Post
              if (this.addPost(this.archiveToPost(item), buffer)) {
                added++;
              }
            } else if (item.body) {
              // Comment
              if (this.addComment(this.archiveToComment(item), buffer)) {
                added++;
              }
            }
          }

          if (added > 0) {
            logger.info(`    +${added} items`);
          }
        }
      } catch (error) {
        logger.debug(`  Archive error: ${error}`);
      }

      await this.sleep(1000); // Be nice to archive API
    }

    this.flushBuffer(buffer);
  }

  // ============================================================================
  // PHASE 5: BROWSER VERIFICATION
  // ============================================================================

  private async phase5_BrowserVerification(buffer: Mention[]): Promise<void> {
    if (this.isTimeUp()) return;

    logger.info('');
    logger.info('PHASE 5: Browser Verification');
    logger.info('-----------------------------');

    let page: Page | null = null;

    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });

      const urls = [
        'https://www.reddit.com/search/?q=matiks&sort=new',
        'https://www.reddit.com/search/?q=matiks&sort=relevance&t=all',
        'https://www.reddit.com/search/?q=matiks&type=comment&sort=new',
        ...getBrandAnchors().map(anchor => `https://www.reddit.com/search/?q=${encodeURIComponent(anchor)}&sort=new`),
      ];

      for (const url of urls) {
        if (this.isTimeUp()) break;

        try {
          logger.info(`  Visiting: ${url.split('?')[1]}`);
          
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await this.sleep(3000);

          // Scroll to load more content
          for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await this.sleep(1000);
          }

          // Extract posts
          const posts = await this.extractPostsFromPage(page);
          let added = 0;
          for (const post of posts) {
            if (this.addPost(post, buffer)) {
              added++;
            }
          }

          if (added > 0) {
            logger.info(`    +${added} from browser`);
          }

        } catch (error) {
          logger.debug(`  Browser page error: ${error}`);
        }
      }

    } catch (error) {
      logger.debug(`  Browser setup error: ${error}`);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      await closeBrowser().catch(() => {});
    }
  }

  // ============================================================================
  // API FETCH METHODS
  // ============================================================================

  private async fetchAllPagesForSearch(query: string, sort: string, time: string, buffer: Mention[]): Promise<void> {
    let after: string | null = null;
    let pageNum = 0;
    const maxPages = 10; // Reddit typically maxes out around 10 pages

    while (pageNum < maxPages && !this.isTimeUp()) {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time}&limit=100&raw_json=1&include_over_18=1${after ? `&after=${after}` : ''}`;

      const data = await this.fetchWithRetry(url);
      if (!data || !data.data?.children?.length) break;

      for (const child of data.data.children) {
        if (child.kind === 't3') {
          this.addPost(child.data, buffer);
        }
      }

      after = data.data.after;
      if (!after) break;
      pageNum++;
    }
  }

  private async searchSubreddit(subreddit: string, buffer: Mention[]): Promise<number> {
    let after: string | null = null;
    let pageNum = 0;
    const maxPages = 5;
    let found = 0;

    while (pageNum < maxPages && !this.isTimeUp()) {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=matiks&restrict_sr=on&sort=relevance&t=all&limit=100&raw_json=1&include_over_18=1${after ? `&after=${after}` : ''}`;

      const data = await this.fetchWithRetry(url);
      if (!data || !data.data?.children?.length) break;

      for (const child of data.data.children) {
        if (child.kind === 't3' && this.addPost(child.data, buffer)) {
          found++;
        }
      }

      after = data.data.after;
      if (!after) break;
      pageNum++;
    }

    return found;
  }

  private async searchComments(query: string, buffer: Mention[]): Promise<void> {
    let after: string | null = null;
    let pageNum = 0;
    const maxPages = 5;

    while (pageNum < maxPages && !this.isTimeUp()) {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&type=comment&sort=relevance&t=all&limit=100&raw_json=1&include_over_18=1${after ? `&after=${after}` : ''}`;

      const data = await this.fetchWithRetry(url);
      if (!data || !data.data?.children?.length) break;

      for (const child of data.data.children) {
        if (child.kind === 't1') {
          this.addComment(child.data, buffer);
        }
      }

      after = data.data.after;
      if (!after) break;
      pageNum++;
    }
  }

  private async fetchWithRetry(url: string, maxRetries: number = 3): Promise<any> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.rateLimiter.acquire();
      this.stats.apiCalls++;

      try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': this.getRandomUserAgent(),
              'Accept': 'application/json',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });

        if (response.status === 429) {
          this.stats.rateLimitHits++;
          this.rateLimiter.onRateLimit();
          const backoff = this.rateLimiter.getBackoffTime();
          logger.warn(`  Rate limited! Waiting ${backoff / 1000}s...`);
          await this.sleep(backoff);
          continue;
        }

        if (!response.ok) {
          await this.sleep(1000);
          continue;
        }

        this.rateLimiter.onSuccess();
        return await response.json();

      } catch (error) {
        if (attempt === maxRetries - 1) return null;
        await this.sleep(2000);
      }
    }

    return null;
  }

  // ============================================================================
  // DATA PROCESSING
  // ============================================================================

  private addPost(post: RedditPost, buffer: Mention[]): boolean {
    if (!post || !post.name) return false;

    // ID-based dedup
    if (this.seenIds.has(post.name)) {
      this.stats.duplicatesSkipped++;
      return false;
    }

    // Content-based dedup (for posts from different sources)
    const contentKey = `${post.title}|${post.author}`.toLowerCase();
    if (this.seenContent.has(contentKey)) {
      this.stats.duplicatesSkipped++;
      return false;
    }

    // Filter check
    const urlHint = post.url || post.permalink || '';
    if (!this.isRelevant(post.title, post.selftext || '', post.subreddit, urlHint)) {
      this.stats.filteredOut++;
      return false;
    }

    this.seenIds.add(post.name);
    this.seenContent.add(contentKey);
    this.stats.postsFound++;
    buffer.push(this.transformPost(post));
    return true;
  }

  private addComment(comment: RedditComment, buffer: Mention[]): boolean {
    if (!comment || !comment.name) return false;

    if (this.seenIds.has(comment.name)) {
      this.stats.duplicatesSkipped++;
      return false;
    }

    const contentKey = `comment|${comment.body?.substring(0, 100)}|${comment.author}`.toLowerCase();
    if (this.seenContent.has(contentKey)) {
      this.stats.duplicatesSkipped++;
      return false;
    }

    if (!this.isRelevant(comment.body || '', '', comment.subreddit, comment.permalink)) {
      this.stats.filteredOut++;
      return false;
    }

    this.seenIds.add(comment.name);
    this.seenContent.add(contentKey);
    this.stats.commentsFound++;
    buffer.push(this.transformComment(comment));
    return true;
  }

  private isRelevant(text1: string, text2: string, subreddit: string, url?: string): boolean {
    const sub = subreddit?.toLowerCase() || '';

    // Always include brand subreddit content
    if (this.brandSubreddits.has(sub)) return true;

    // Subreddit exclusion
    if (this.excludeSubreddits.has(sub)) return false;

    const combined = `${text1} ${text2} ${url || ''}`.toLowerCase();

    if (config.brandStrict) {
      return matchesBrand(combined);
    }

    if (config.brandBalanced) {
      if (!matchesBrandBalanced(combined, this.contextKeywords)) return false;
    } else {
      if (!matchesBrand(combined)) return false;
    }

    // Additional safety checks in balanced mode
    for (const pattern of this.excludePatterns) {
      if (pattern.test(combined)) return false;
    }

    return true;
  }

  // ============================================================================
  // BRAND SUBREDDIT LISTING FETCHERS
  // ============================================================================

  private async fetchSubredditListings(subreddit: string, sort: 'new' | 'hot', buffer: Mention[]): Promise<void> {
    let after: string | null = null;
    let pageNum = 0;
    const maxPages = 10;

    while (pageNum < maxPages && !this.isTimeUp()) {
      const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=100&raw_json=1&include_over_18=1${after ? `&after=${after}` : ''}`;
      const data = await this.fetchWithRetry(url);
      if (!data || !data.data?.children?.length) break;

      for (const child of data.data.children) {
        if (child.kind === 't3') {
          this.addPost(child.data, buffer);
        }
      }

      after = data.data.after;
      if (!after) break;
      pageNum++;
    }
  }

  private async fetchSubredditComments(subreddit: string, buffer: Mention[]): Promise<void> {
    let after: string | null = null;
    let pageNum = 0;
    const maxPages = 5;

    while (pageNum < maxPages && !this.isTimeUp()) {
      const url = `https://www.reddit.com/r/${subreddit}/comments.json?limit=100&raw_json=1&include_over_18=1${after ? `&after=${after}` : ''}`;
      const data = await this.fetchWithRetry(url);
      if (!data || !data.data?.children?.length) break;

      for (const child of data.data.children) {
        if (child.kind === 't1') {
          this.addComment(child.data, buffer);
        }
      }

      after = data.data.after;
      if (!after) break;
      pageNum++;
    }
  }

  private flushBuffer(buffer: Mention[]): void {
    if (buffer.length === 0) return;

    // Add sentiment
    for (const mention of buffer) {
      const sentiment = analyzeSentiment(mention.content);
      mention.sentiment_score = sentiment.score;
      mention.sentiment_label = sentiment.label;
    }

    const saved = insertMentions(buffer);
    this.stats.saved += saved;
    
    if (saved > 0) {
      logger.info(`  💾 Saved ${saved} to database (total: ${this.stats.saved})`);
    }

    buffer.length = 0;
  }

  // ============================================================================
  // TRANSFORMERS
  // ============================================================================

  private transformPost(post: RedditPost): Mention {
    let content = post.title || '';
    if (post.selftext && !['[removed]', '[deleted]'].includes(post.selftext)) {
      content += '\n\n' + post.selftext;
    }
    if (post.preview?.images?.[0]?.source?.url) {
      content += '\n\n📷 ' + post.preview.images[0].source.url.replace(/&amp;/g, '&');
    }

    return {
      platform_id: PLATFORMS.reddit,
      external_id: post.name,
      author: post.author || '[deleted]',
      author_url: post.author && post.author !== '[deleted]' ? `https://reddit.com/u/${post.author}` : null,
      content: content.trim(),
      url: post.permalink?.startsWith('http') ? post.permalink : `https://reddit.com${post.permalink}`,
      engagement_likes: post.score || 0,
      engagement_comments: post.num_comments || 0,
      engagement_shares: 0,
      sentiment_score: null,
      sentiment_label: null,
      created_at: new Date((post.created_utc || Date.now() / 1000) * 1000).toISOString(),
    };
  }

  private transformComment(comment: RedditComment): Mention {
    return {
      platform_id: PLATFORMS.reddit,
      external_id: comment.name,
      author: comment.author || '[deleted]',
      author_url: comment.author && comment.author !== '[deleted]' ? `https://reddit.com/u/${comment.author}` : null,
      content: comment.body?.trim() || '',
      url: comment.permalink?.startsWith('http') ? comment.permalink : `https://reddit.com${comment.permalink}`,
      engagement_likes: comment.score || 0,
      engagement_comments: 0,
      engagement_shares: 0,
      sentiment_score: null,
      sentiment_label: null,
      created_at: new Date((comment.created_utc || Date.now() / 1000) * 1000).toISOString(),
    };
  }

  private archiveToPost(item: any): RedditPost {
    return {
      id: item.id,
      name: item.name || `t3_${item.id}`,
      title: item.title || '',
      author: item.author || '[deleted]',
      subreddit: item.subreddit || 'unknown',
      permalink: item.permalink || `/r/${item.subreddit}/comments/${item.id}`,
      selftext: item.selftext || '',
      score: item.score || 0,
      num_comments: item.num_comments || 0,
      created_utc: item.created_utc || Date.now() / 1000,
    };
  }

  private archiveToComment(item: any): RedditComment {
    return {
      id: item.id,
      name: item.name || `t1_${item.id}`,
      author: item.author || '[deleted]',
      body: item.body || '',
      score: item.score || 0,
      created_utc: item.created_utc || Date.now() / 1000,
      permalink: item.permalink || `/r/${item.subreddit}/comments/${item.link_id?.split('_')[1]}/c/${item.id}`,
      subreddit: item.subreddit || 'unknown',
    };
  }

  private async extractPostsFromPage(page: Page): Promise<RedditPost[]> {
    return await page.evaluate(() => {
      const results: any[] = [];

      document.querySelectorAll('shreddit-post, [data-testid="post-container"]').forEach((el) => {
        try {
          const title = el.getAttribute('post-title') || el.querySelector('h3')?.textContent || '';
          const author = el.getAttribute('author') || '';
          const id = el.getAttribute('id') || `browser-${Date.now()}-${Math.random()}`;
          const permalink = el.getAttribute('permalink') || '';
          const score = parseInt(el.getAttribute('score') || '0') || 0;

          if (title && title.toLowerCase().includes('matiks')) {
            results.push({
              id,
              name: `t3_${id}`,
              title,
              author,
              subreddit: permalink.split('/')[2] || 'unknown',
              permalink,
              selftext: '',
              score,
              num_comments: 0,
              created_utc: Date.now() / 1000,
            });
          }
        } catch {}
      });

      return results;
    });
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  private isTimeUp(): boolean {
    return Date.now() - this.startTime > this.maxDuration;
  }

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
