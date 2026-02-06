import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

// Ensure data directory exists
if (!fs.existsSync(config.paths.data)) {
  fs.mkdirSync(config.paths.data, { recursive: true });
}

const dbPath = path.join(config.paths.data, 'matiks.db');
export const db = new Database(dbPath);

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

export const schema = `
-- Platforms
CREATE TABLE IF NOT EXISTS platforms (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL
);

-- Insert default platforms
INSERT OR IGNORE INTO platforms (id, name, type) VALUES
  (1, 'reddit', 'social'),
  (4, 'playstore', 'appstore'),
  (5, 'appstore', 'appstore');

-- Scrape cursors for incremental fetching
CREATE TABLE IF NOT EXISTS scrape_cursors (
  platform TEXT PRIMARY KEY,
  last_scraped_at TEXT NOT NULL,
  last_item_date TEXT,
  last_item_ids TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Social media mentions
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id INTEGER REFERENCES platforms(id),
  external_id TEXT NOT NULL,
  author TEXT,
  author_url TEXT,
  content TEXT,
  url TEXT,
  engagement_likes INTEGER DEFAULT 0,
  engagement_comments INTEGER DEFAULT 0,
  engagement_shares INTEGER DEFAULT 0,
  sentiment_score REAL,
  sentiment_label TEXT,
  created_at TEXT NOT NULL,
  scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform_id, external_id)
);

-- App store reviews
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id INTEGER REFERENCES platforms(id),
  external_id TEXT NOT NULL,
  author TEXT,
  rating INTEGER,
  title TEXT,
  content TEXT,
  app_version TEXT,
  helpful_count INTEGER DEFAULT 0,
  developer_reply TEXT,
  sentiment_score REAL,
  sentiment_label TEXT,
  review_date TEXT NOT NULL,
  scraped_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform_id, external_id)
);

-- Scrape job logs
CREATE TABLE IF NOT EXISTS scrape_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  items_found INTEGER DEFAULT 0,
  items_new INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mentions_platform ON mentions(platform_id);
CREATE INDEX IF NOT EXISTS idx_mentions_created ON mentions(created_at);
CREATE INDEX IF NOT EXISTS idx_mentions_sentiment ON mentions(sentiment_label);
CREATE INDEX IF NOT EXISTS idx_reviews_platform ON reviews(platform_id);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);

-- ============================================================================
-- Outreach (Compliance-first Reddit helper; no autonomous posting)
-- ============================================================================

-- Stores a single Reddit OAuth token set for the local user.
CREATE TABLE IF NOT EXISTS outreach_reddit_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT,
  expires_at TEXT,
  reddit_username TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- OAuth anti-CSRF state store (short-lived).
CREATE TABLE IF NOT EXISTS outreach_oauth_states (
  state TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Target subreddits and their synced rules.
CREATE TABLE IF NOT EXISTS outreach_subreddits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  cooldown_hours INTEGER NOT NULL DEFAULT 168,
  rules_json TEXT,
  last_rules_sync_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Draft posts for manual review/approval and one-click submission.
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subreddit_id INTEGER NOT NULL REFERENCES outreach_subreddits(id),
  kind TEXT NOT NULL, -- 'self' | 'link'
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  disclosure TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft' | 'posted' | 'failed'
  reddit_post_id TEXT,
  reddit_post_url TEXT,
  last_error TEXT,
  posted_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Keeps an audit trail of post attempts and responses.
CREATE TABLE IF NOT EXISTS outreach_post_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES outreach_drafts(id),
  status TEXT NOT NULL, -- 'success' | 'failed'
  response_json TEXT,
  error TEXT,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outreach_subreddits_enabled ON outreach_subreddits(enabled);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_subreddit ON outreach_drafts(subreddit_id);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_status ON outreach_drafts(status);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_posted_at ON outreach_drafts(posted_at);
`;

export function initializeDatabase() {
  db.exec(schema);
  console.log('✅ Database initialized at:', dbPath);
}
