import { db } from './schema.js';

// Platform IDs
export const PLATFORMS = {
  reddit: 1,
  playstore: 4,
  appstore: 5,
} as const;

export type PlatformName = keyof typeof PLATFORMS;

// Mention types
export interface Mention {
  id?: number;
  platform_id: number;
  external_id: string;
  author: string | null;
  author_url: string | null;
  content: string | null;
  url: string | null;
  engagement_likes: number;
  engagement_comments: number;
  engagement_shares: number;
  sentiment_score: number | null;
  sentiment_label: string | null;
  created_at: string;
  scraped_at?: string;
}

export interface Review {
  id?: number;
  platform_id: number;
  external_id: string;
  author: string | null;
  rating: number;
  title: string | null;
  content: string | null;
  app_version: string | null;
  helpful_count: number;
  developer_reply: string | null;
  sentiment_score: number | null;
  sentiment_label: string | null;
  review_date: string;
  scraped_at?: string;
}

export interface ScrapeLog {
  id?: number;
  platform: string;
  status: 'running' | 'success' | 'failed';
  items_found: number;
  items_new: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

// Insert mention (upsert)
const insertMentionStmt = db.prepare(`
  INSERT INTO mentions (platform_id, external_id, author, author_url, content, url, 
    engagement_likes, engagement_comments, engagement_shares, sentiment_score, sentiment_label, created_at)
  VALUES (@platform_id, @external_id, @author, @author_url, @content, @url,
    @engagement_likes, @engagement_comments, @engagement_shares, @sentiment_score, @sentiment_label, @created_at)
  ON CONFLICT(platform_id, external_id) DO UPDATE SET
    author = excluded.author,
    author_url = excluded.author_url,
    content = excluded.content,
    url = excluded.url,
    engagement_likes = excluded.engagement_likes,
    engagement_comments = excluded.engagement_comments,
    engagement_shares = excluded.engagement_shares,
    sentiment_score = excluded.sentiment_score,
    sentiment_label = excluded.sentiment_label
`);

export function insertMention(mention: Mention): boolean {
  const result = insertMentionStmt.run(mention);
  return result.changes > 0;
}

// Batch insert mentions
export function insertMentions(mentions: Mention[]): number {
  let newCount = 0;
  const transaction = db.transaction((items: Mention[]) => {
    for (const mention of items) {
      try {
        const existing = db.prepare('SELECT id FROM mentions WHERE platform_id = ? AND external_id = ?')
          .get(mention.platform_id, mention.external_id);
        insertMentionStmt.run(mention);
        if (!existing) newCount++;
      } catch (e) {
        // Skip duplicates
      }
    }
  });
  transaction(mentions);
  return newCount;
}

// Insert review (upsert)
const insertReviewStmt = db.prepare(`
  INSERT INTO reviews (platform_id, external_id, author, rating, title, content,
    app_version, helpful_count, developer_reply, sentiment_score, sentiment_label, review_date)
  VALUES (@platform_id, @external_id, @author, @rating, @title, @content,
    @app_version, @helpful_count, @developer_reply, @sentiment_score, @sentiment_label, @review_date)
  ON CONFLICT(platform_id, external_id) DO UPDATE SET
    author = excluded.author,
    rating = excluded.rating,
    title = excluded.title,
    content = excluded.content,
    app_version = excluded.app_version,
    helpful_count = excluded.helpful_count,
    developer_reply = excluded.developer_reply,
    sentiment_score = excluded.sentiment_score,
    sentiment_label = excluded.sentiment_label
`);

export function insertReview(review: Review): boolean {
  const result = insertReviewStmt.run(review);
  return result.changes > 0;
}

// Batch insert reviews
export function insertReviews(reviews: Review[]): number {
  let newCount = 0;
  const transaction = db.transaction((items: Review[]) => {
    for (const review of items) {
      try {
        const existing = db.prepare('SELECT id FROM reviews WHERE platform_id = ? AND external_id = ?')
          .get(review.platform_id, review.external_id);
        insertReviewStmt.run(review);
        if (!existing) newCount++;
      } catch (e) {
        // Skip duplicates
      }
    }
  });
  transaction(reviews);
  return newCount;
}

// Query mentions with filters
export interface MentionFilters {
  platform?: PlatformName;
  sentiment?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export function getMentions(filters: MentionFilters = {}): Mention[] {
  let query = 'SELECT m.*, p.name as platform_name FROM mentions m JOIN platforms p ON m.platform_id = p.id WHERE 1=1';
  const params: any[] = [];
  
  if (filters.platform) {
    query += ' AND p.name = ?';
    params.push(filters.platform);
  }
  if (filters.sentiment) {
    query += ' AND m.sentiment_label = ?';
    params.push(filters.sentiment);
  }
  if (filters.search) {
    query += ' AND (m.content LIKE ? OR m.author LIKE ? OR m.url LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.startDate) {
    query += ' AND m.created_at >= ?';
    params.push(filters.startDate);
  }
  
  // Single Filter Mode: If only start date is picked, show ONLY that day.
  // Range Mode: If end date is also picked, use it.
  const effectiveEndDate = filters.endDate || filters.startDate;
  
  if (effectiveEndDate) {
    query += ' AND m.created_at <= ?';
    const end = effectiveEndDate.length === 10 ? effectiveEndDate + 'T23:59:59' : effectiveEndDate;
    params.push(end);
  }
  
  query += ' ORDER BY m.created_at DESC';
  
  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }
  }
  
  return db.prepare(query).all(...params) as Mention[];
}

// Query reviews with filters
export interface ReviewFilters {
  platform?: 'playstore' | 'appstore';
  rating?: number;
  sentiment?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export function getReviews(filters: ReviewFilters = {}): Review[] {
  let query = 'SELECT r.*, p.name as platform_name FROM reviews r JOIN platforms p ON r.platform_id = p.id WHERE 1=1';
  const params: any[] = [];
  
  if (filters.platform) {
    query += ' AND p.name = ?';
    params.push(filters.platform);
  }
  if (filters.rating) {
    query += ' AND r.rating = ?';
    params.push(filters.rating);
  }
  if (filters.sentiment) {
    query += ' AND r.sentiment_label = ?';
    params.push(filters.sentiment);
  }
  if (filters.search) {
    query += ' AND (r.content LIKE ? OR r.title LIKE ? OR r.author LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.startDate) {
    query += ' AND r.review_date >= ?';
    params.push(filters.startDate);
  }
  
  // Single Filter Mode: If only start date is picked, show ONLY that day.
  // Range Mode: If end date is also picked, use it.
  const effectiveEndDate = filters.endDate || filters.startDate;

  if (effectiveEndDate) {
    query += ' AND r.review_date <= ?';
    const end = effectiveEndDate.length === 10 ? effectiveEndDate + 'T23:59:59' : effectiveEndDate;
    params.push(end);
  }
  
  query += ' ORDER BY r.review_date DESC';
  
  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
    if (filters.offset) {
      query += ' OFFSET ?';
      params.push(filters.offset);
    }
  }
  
  return db.prepare(query).all(...params) as Review[];
}

// Get stats
export function getStats() {
  const mentionStats = db.prepare(`
    SELECT 
      p.name as platform,
      COUNT(*) as total,
      SUM(CASE WHEN m.sentiment_label = 'positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN m.sentiment_label = 'neutral' THEN 1 ELSE 0 END) as neutral,
      SUM(CASE WHEN m.sentiment_label = 'negative' THEN 1 ELSE 0 END) as negative,
      AVG(m.sentiment_score) as avg_sentiment
    FROM mentions m
    JOIN platforms p ON m.platform_id = p.id
    GROUP BY p.name
  `).all();
  
  const reviewStats = db.prepare(`
    SELECT 
      p.name as platform,
      COUNT(*) as total,
      AVG(r.rating) as avg_rating,
      SUM(CASE WHEN r.rating >= 4 THEN 1 ELSE 0 END) as positive_reviews,
      SUM(CASE WHEN r.rating <= 2 THEN 1 ELSE 0 END) as negative_reviews
    FROM reviews r
    JOIN platforms p ON r.platform_id = p.id
    GROUP BY p.name
  `).all();
  
  const recentMentions = db.prepare(`
    SELECT COUNT(*) as count FROM mentions WHERE created_at >= datetime('now', '-24 hours')
  `).get() as { count: number };
  
  const recentReviews = db.prepare(`
    SELECT COUNT(*) as count FROM reviews WHERE review_date >= datetime('now', '-24 hours')
  `).get() as { count: number };
  
  return {
    mentions: mentionStats,
    reviews: reviewStats,
    last24h: {
      mentions: recentMentions.count,
      reviews: recentReviews.count,
    },
  };
}

// Scrape logs
export function logScrapeStart(platform: string): number {
  const result = db.prepare(`
    INSERT INTO scrape_logs (platform, status, started_at) VALUES (?, 'running', datetime('now'))
  `).run(platform);
  return result.lastInsertRowid as number;
}

export function logScrapeEnd(id: number, status: 'success' | 'failed', itemsFound: number, itemsNew: number, error?: string) {
  db.prepare(`
    UPDATE scrape_logs SET status = ?, items_found = ?, items_new = ?, error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).run(status, itemsFound, itemsNew, error || null, id);
}

export function getRecentLogs(limit = 20): ScrapeLog[] {
  return db.prepare(`
    SELECT * FROM scrape_logs ORDER BY started_at DESC LIMIT ?
  `).all(limit) as ScrapeLog[];
}

// ============================================================================
// INCREMENTAL SCRAPING CURSORS
// ============================================================================

export interface ScrapeCursor {
  platform: string;
  last_scraped_at: string;
  last_item_date: string | null;
  last_item_ids: string | null;
}

const getCursorStmt = db.prepare('SELECT * FROM scrape_cursors WHERE platform = ?');
const upsertCursorStmt = db.prepare(`
  INSERT INTO scrape_cursors (platform, last_scraped_at, last_item_date, last_item_ids, updated_at)
  VALUES (@platform, datetime('now'), @last_item_date, @last_item_ids, datetime('now'))
  ON CONFLICT(platform) DO UPDATE SET
    last_scraped_at = datetime('now'),
    last_item_date = excluded.last_item_date,
    last_item_ids = excluded.last_item_ids,
    updated_at = datetime('now')
`);

export function getScrapeCursor(platform: string): ScrapeCursor | null {
  return getCursorStmt.get(platform) as ScrapeCursor | null;
}

export function updateScrapeCursor(
  platform: string, 
  lastItemDate?: string, 
  lastItemIds?: string[]
): void {
  upsertCursorStmt.run({
    platform,
    last_item_date: lastItemDate || null,
    last_item_ids: lastItemIds ? JSON.stringify(lastItemIds) : null
  });
}

// Helper to get recent external IDs for deduplication
export function getRecentExternalIds(platform: PlatformName, limit = 1000): string[] {
  // Select IDs from appropriate table based on platform type
  const platformId = PLATFORMS[platform];
  if (!platformId) return [];

  // Determine which table to query
  const isAppStore = platform === 'appstore' || platform === 'playstore';
  const table = isAppStore ? 'reviews' : 'mentions';
  const orderBy = isAppStore ? 'review_date' : 'created_at';

  const rows = db.prepare(`
    SELECT external_id 
    FROM ${table} 
    WHERE platform_id = ? 
    ORDER BY ${orderBy} DESC 
    LIMIT ?
  `).all(platformId, limit) as { external_id: string }[];

  return rows.map(row => row.external_id);
}
