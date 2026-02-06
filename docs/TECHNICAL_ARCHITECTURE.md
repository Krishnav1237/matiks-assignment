# Technical Architecture: Matiks Social Media Monitor

> **Version:** 1.0.0-mvp
> **Date:** 2026-01-31
> **Status:** Production-Ready MVP

This document provides an exhaustive technical overview of the Matiks Social Media Monitor. It details the system architecture, design decisions, component implementations, database schema, and operational workflows. It is intended for developers, system architects, and maintainers.

## 1. System Overview

### 1.1 Philosophy & Design Goals
The Matiks Monitor was built with three core design principles in mind, adhering to the requirement of a "simplified, locally runnable" MVP:

1.  **Zero-Configuration Infrastructure**: The system avoids external dependencies like Docker, PostgreSQL, or Redis. It uses a single-process Node.js runtime with an embedded SQLite database (`better-sqlite3`). This allows the application to be cloned and run immediately (`npm start`) on any machine with Node.js, fulfilling the portability requirement.
2.  **Resilience First**: Social media scraping is inherently unstable. The system is defensive by design, implementing aggressive error handling, exponential backoff retries, and strict rate limiting at the application level to prevent IP bans and ensure long-term stability.
3.  **Monolithic Simplicity**: Rather than a microservices web, the application operates as a modular monolith. The Web Server, Scheduler, and Scrapers run within the same process event loop. This minimizes overhead and eliminates network latency between components, making it ideal for an MVP scale.

### 1.2 High-Level Architecture
The system follows a layered architecture pattern:

```mermaid
graph TD
    User[User / Administrator]
    Browser[Headless Browser (Playwright)]
    
    subgraph "Matiks Monitor (Node.js Process)"
        Web[Web Server (Express)]
        Scheduler[Cron Scheduler]
        
        subgraph "Core Domain"
            ScraperEngine[Scraper Engine]
            RateLimiter[Rate Limiter]
            Humanizer[Human Behavior Simulator]
        end
        
        subgraph "Data Layer"
            Sentiment[Sentiment Analysis Service]
            DB_Adapter[Database Adapter (better-sqlite3)]
        end
    end
    
    subgraph "External Targets"
        Reddit
        Twitter
        LinkedIn
        PlayStore
        AppStore
    end
    
    subgraph "Persistence"
        SQLite[(SQLite Database)]
        FileSystem[Log Files]
    end

    User -->|Views Dashboard| Web
    User -->|Triggers Scrapers| Web
    Scheduler -->|Triggers| ScraperEngine
    Web -->|Quality Check| SQLite
    
    ScraperEngine -->|Checks Quota| RateLimiter
    ScraperEngine -->|Controls| Browser
    Browser -->|Simulates User| External Targets
    
    ScraperEngine -->|Raw Data| Sentiment
    Sentiment -->|Enriched Data| DB_Adapter
    DB_Adapter -->|Persist| SQLite
    
    ScraperEngine -->|Logs| FileSystem
```

## 2. Directory Structure & Code Organization

The codebase is organized as a monorepo with clear separation of concerns.

```
/src
├── config.ts           # Centralized configuration loader. Validates .env vars and exports strict types.
├── index.ts            # Application entry point. Bootstraps DB, Server, and Scheduler.
├── core/               # Shared infrastructure utilities
│   ├── browser.ts      # Playwright wrapper. Handles context creation, stealth injection, and proxies.
│   ├── humanize.ts     # Behavioral algorithms. Implements random distribution delays and mouse paths.
│   ├── logger.ts       # Winston logger configuration. Handles file rotation and console output formatting.
│   └── rateLimit.ts    # Token Bucket implementation. Manages concurrency and request quotas per platform.
├── db/                 # Data persistence layer
│   ├── init.ts         # Database bootstrapping script. Runs DDL migrations.
│   ├── queries.ts      # Typed Data Access Object (DAO) layer. All SQL queries live here.
│   └── schema.ts       # DDL definitions for SQLite tables.
├── pipeline/           # Data processing
│   └── sentiment.ts    # NLP Engine. Wraps `natural` library for text classification.
├── scheduler/          # Automation layer
│   └── jobs.ts         # Cron job definitions using `node-cron`.
├── scrapers/           # Business logic
│   ├── base.ts         # Abstract Base Scraper class. Defines the template method pattern for scraping.
│   ├── appstore.ts     # Apple App Store implementation (RSS Feed)
│   ├── linkedin.ts     # LinkedIn implementation (Auth + DOM Scraping)
│   ├── playstore.ts    # Google Play Store implementation (scraper + Playwright fallback)
│   ├── reddit.ts       # Reddit implementation (public JSON search)
│   ├── twitter.ts      # Twitter/X implementation (Auth + DOM Scraping)
│   └── run.ts          # CLI Task Runner for manual execution.
└── web/                # Presentation layer
    ├── server.ts       # Express application setup, middleware, and routing.
    └── views/          # EJS templates for the dashboard UI.
```

### Key Design Decisions:
*   **Centralized Config**: `config.ts` acts as the single source of truth with sane defaults. Missing critical config (e.g., credentials) results in scheduler skips rather than repeated failures.
*   **Abstract Base Class**: `src/scrapers/base.ts` standardizes lifecycle and error handling for Playwright-driven scrapers (Twitter/LinkedIn). Other scrapers implement custom flows where faster API-like endpoints are available.

## 3. Component Deep Dive

### 3.1 Browser Automation (The Scraper Core)
We utilize **Microsoft Playwright** over Puppeteer due to its superior handling of modern web features, stronger selector engine, and better multi-browser support.

#### Stealth Implementation
Detection avoidance is critical. We inject custom scripts into every page frame before it loads:
1.  **`navigator.webdriver` Removal**: We delete this property to hide the automation flag.
2.  **Hardware Concurrency Mocking**: We report a realistic number of CPU cores (e.g., 4 or 8) instead of the VM default.
3.  **Plugin Mocking**: We inject fake plugin array data (PDF Viewer, Chrome PDF) to mimic a desktop Chrome browser.
4.  **Language Headers**: We ensure `Accept-Language` headers match the browser's mocked locale.

#### Context Management
To support concurrent scraping without cross-contamination:
*   Each scraper instance launches its own **BrowserContext**.
*   Cookies are loaded from the filesystem (`/cookies/*.json`) into the context at startup.
*   Upon successful login, cookies are serialized and written back to disk.
*   This allows session persistence across application restarts, minimizing login attempts (which are high-risk behaviors).

### 3.2 Rate Limiter (Token Bucket Algorithm)
Top protect our IP reputation, we implement a **Token Bucket** algorithm in `src/core/rateLimit.ts` rather than a simple fixed window counter.

*   **Mechanism**:
    *   Each platform bucket starts with a capacity (e.g., 10 tokens).
    *   Tokens replenish at a fixed rate (e.g., 1 token every 20 seconds).
    *   Every request costs 1 token.
    *   If the bucket is empty, the scraper `await`s a promise that resolves when a token is generated.
*   **Backoff**:
    *   If an interaction fails (catch block), the rate limiter adds an artificial "penalty" delay, effectively pausing scraping for that platform.
    *   This implements an autonomous "cool-down" period when platforms are detecting high activity.

### 3.3 Sentiment Analysis Engine
We deliberately chose a local NLP approach over cloud APIs (like OpenAI or Google Cloud NLP) to keep the "zero-cost" promise of the MVP.

*   **Library**: `natural` (Node.js NLP library).
*   **Lexicon**: **AFINN-165**.
    *   This is a list of 2,477 words and phrases rated with an integer between -5 (very negative) and +5 (very positive).
*   **Scoring Logic**:
    1.  Tokenize input text.
    2.  Match tokens against the AFINN lexicon.
    3.  Sum the score.
    4.  **Normalization**: The raw score is clamped to a -1 to 1 range to keep comparisons consistent across platforms.
    5.  **Classification**:
        *   Score > 0.1: `positive`
        *   Score < -0.1: `negative`
        *   Else: `neutral`

### 3.4 Scheduler & Event Loop
The system runs on the Node.js main thread. The `src/scheduler/jobs.ts` file utilizes `node-cron` to schedule tasks.

*   **Concurrency Strategy**:
    *   Scrapers are asynchronous functions.
    *   We deliberately *do not* use worker threads for this MVP to keep memory usage low (Playwright processes are heavy).
    *   Cron jobs are staggered (offset by minutes) to prevent all browsers launching simultaneously, which could spike CPU usage and crash smaller VPS instances.

## 4. Database Schema & Persistence

We use **SQLite** with the `better-sqlite3` driver. This driver is synchronous, which provides massive performance benefits for SQLite's serial write model and simplified code (no `await` for simple inserts).

### 4.1 Schema Definition (`src/db/schema.ts`)

#### `platforms` Table
Lookup table for supported sources.
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Internal platform ID |
| name | TEXT UNIQUE | Platform slug (e.g., `reddit`, `twitter`) |
| type | TEXT | `social` or `appstore` |

#### `mentions` Table
Stores social media posts (Reddit, Twitter, LinkedIn).
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment internal ID |
| platform_id | INTEGER FK | Reference to platforms |
| external_id | TEXT | The platform's native ID (tweet ID, reddit post ID) |
| author | TEXT | Username/Handle |
| content | TEXT | The post body text |
| url | TEXT | Permalinks |
| sentiment_score | REAL | Normalized -1 to 1 |
| sentiment_label | TEXT | 'positive', 'neutral', 'negative' |
| engagement_* | INT | Likes, shares, comments counts |
| created_at | TEXT | ISO8601 Timestamp |

**Indexes**:
*   `UNIQUE(platform_id, external_id)`: Prevents duplicate data ingestion. We use `INSERT OR IGNORE` or `UPSERT` strategies.
*   `IDX_mentions_created_at`: Optimizes time-range queries for the dashboard.
*   `IDX_mentions_sentiment`: Optimizes filtering by sentiment.

#### `reviews` Table
Stores App Store / Play Store reviews. Structure is similar to `mentions` but includes:
*   `rating` (INTEGER): Star rating (1-5).
*   `app_version` (TEXT): The version user reviewed.
*   `title` (TEXT): Review headline.
*   `helpful_count` (INTEGER): Helpful/upvote count when available.
*   `developer_reply` (TEXT): Developer response if available.

#### `scrape_logs`
Audit trail for system health.
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Unique Job ID |
| platform | TEXT | Target platform |
| status | TEXT | 'running', 'success', 'failed' |
| items_found | INT | Total parsed count |
| items_new | INT | Actually inserted count |
| error | TEXT | Stack trace if failed |
| started_at | TEXT | Start timestamp |
| completed_at | TEXT | End timestamp |

### 4.2 Why SQLite WAL Mode?
We enable Write-Ahead Logging (WAL) mode with `PRAGMA journal_mode = WAL;`.
*   **Concurrency**: WAL allows simultaneous readers and one writer. This is crucial as the Dashboard (Reader) might be querying heavy stats while a Scraper (Writer) is inserting new tweets. Without WAL, the dashboard would lock the DB, potentially causing scraper timeouts.
*   **Performance**: WAL writes are sequential and faster than standard rollback journaling.

## 5. Web Interface (The Dashboard)

The web layer is built with **Express.js** and **EJS** (Embedded JavaScript) templates.

### 5.1 MVC Implementation
*   **Model**: The `src/db/queries.ts` file acts as the Model layer. It abstracts SQL queries into typed functions (`getMentions()`, `insertReview()`).
*   **Controller**: The route handlers in `src/web/server.ts` act as Controllers. They interface between the HTTP request, the Model data, and the View rendering.
*   **View**: The `.ejs` files in `src/web/views/` are the presentation layer.

### 5.2 Server-Side Rendering (SSR) justification
We chose SSR over a Single Page Application (SPA) like React for the MVP:
1.  **Simplicity**: No build step for the frontend (Webpack/Vite avoided).
2.  **Performance**: HTML is rendered on the server; the client receives a fully painted page. For an internal dashboard with low interactivity requirements, this is highly efficient.
3.  **Dependency Reduction**: Removes the need for a separate frontend API serialization layer; we pass objects directly to the template engine.

## 6. Operational Workflows

### 6.1 The Daily Scrape Cycle
1.  **Trigger**: Cron job fires (e.g., 10:00 AM).
2.  **Initialization**:
    *   New Job ID generated in `scrape_logs`.
    *   Status set to `running`.
3.  **Execution**:
    *   Browser launches.
    *   Cookies loaded.
    *   Rate limiter checked.
    *   Navigation to target URL.
    *   DOM parsing extracts raw objects.
4.  **Processing**:
    *   Raw text passed to Sentiment Engine.
    *   Objects transformed into DB Schema format.
5.  **Persistence**:
    *   Batch Insert transaction engaged.
    *   `INSERT OR IGNORE` executed.
    *   Values of `items_found` and `items_new` calculated.
6.  **Teardown**:
    *   Browser context closed.
    *   Status updated to `success` in logs.
    *   Session cookies saved (if changed).

### 6.2 Error Recovery Strategy
If a scraper fails (e.g., Timeout, Selector not found, Network error):
1.  **Immediate Catch**: The `BaseScraper` class catches the error.
2.  **Screenshot**: A debug screenshot is taken (if configured) for analysis.
3.  **Logging**: Full stack trace written to `logs/error.log`.
4.  **DB Update**: The job entry in `scrape_logs` is marked `failed` with the error message.
5.  **No Crash**: The main process *does not exit*. The scheduler remains alive for the next job. This "catch-all" at the job level guarantees the daemon is long-lived.

## 7. Security Considerations

*   **Credential Storage**: Credentials are loaded from process environment variables (`.env`). They are never committed to code.
*   **SQL Injection**: Using `better-sqlite3`'s prepared statements (`db.prepare()`) automatically sanitizes all inputs. We never concatenate strings into SQL queries.
*   **XSS Protection**: EJS escapes output by default. Any user content (Tweet bodies, Review text) is treated as untrusted and escaped before rendering in the dashboard.

## 8. Scalability & Limits

### Current Bottlenecks (MVP Limits)
*   **Memory**: Node.js heap + Chromium processes are RAM hungry. A 1GB VPS might struggle running multiple concurrent scrapers.
*   **SQLite Locking**: While WAL helps, extremely high write volume (100k+ inserts/min) would degrade dashboard read performance.
*   **IP Reputation**: Without expensive residential proxy pools, aggressive scraping schedules (e.g., every 5 mins) will lead to IP bans from Twitter/LinkedIn.

### Future Upgrade Path
1.  **Database**: Migrate form SQLite to PostgreSQL. The `db/queries.ts` layer would need to be rewritten, but business logic remains same.
2.  **Queue**: Move from in-memory `node-cron` to Redis-backed `BullMQ` for job persistence and distributed workers.
3.  **Proxies**: Integrate a rotating proxy service API into `browser.ts`.

---
*End of Technical Architecture Document*
