# Matiks Monitor: System Architecture & Reliability Engineering
> **Document ID:** SYS-ARCH-MASTER-V1
> **Scope:** Architecture, SRE, Automation, and Future Scaling
> **Status:** Production Release

---

# 1. Executive Summary

This document serves as the definitive backend engineering reference for the Matiks Social Media Monitor. It consolidates the technical architecture, automation logic, reliability engineering (SRE) principles, and the future modernization roadmap into a single holistic blueprint.

The system is designed as a **Fault-Tolerant Modular Monolith**, capable of autonomous operation for months without human intervention, utilizing rigorous state management to handle the unreliable nature of web scraping.

---

# 2. Part I: Core System Architecture

## 2.1 Design Philosophy
The architecture prioritizes **Robustness** over raw speed.
1.  **Fail-Safe by Default:** Every external interaction (Network, API, Browser) is wrapped in retry logic and error boundaries.
2.  **Strict Type Safety:** 100% TypeScript coverage with `Zod` runtime validation for configuration ensures impossible states are caught at startup.
3.  **Incremental Intelligence:** The system creates "Cursors" for every scrape job. It never re-scrapes old data unless explicitly forced, optimizing bandwidth and processing time.
4.  **Resource Efficiency:** Uses lightweight `better-sqlite3` (C++ bindings) for high-performance localized storage, avoiding the overhead of heavy database servers like Postgres for this scale.

## 2.2 Functional Blocks
```mermaid
graph TD
    User[Analyst] -->|Views| Dashboard[Web Dashboard (Express/EJS)]
    Config[.env] -->|Validates| Zod[Zod Schema]
    
    subgraph "Orchestration Layer"
        Cron[node-cron] -->|Triggers| Manager[Job Manager]
        Manager -->|Locks| Mutex[Concurrency Lock]
    end
    
    subgraph "Ingestion Engine"
        Manager -->|Spawns| Reddit[Reddit Scraper]
        Manager -->|Spawns| PlayStore[Google Play Scraper]
        Manager -->|Spawns| AppStore[Apple App Store Scraper]
        
        Reddit -->|Raw JSON/HTML| Parser
        PlayStore -->|Protobuf/HTML| Parser
        AppStore -->|RSS/HTML| Parser
    end
        
    subgraph "Processing & Storage"
        Parser -->|Text| NLP[Sentiment Engine]
        NLP -->|Entities| DB[(SQLite WAL Mode)]
        DB -->|Cursors| State[State Manager]
        State -->|Next Start Time| Manager
    end
    
    Dashboard -->|Reads| DB
    Dashboard -->|Triggers| Export[Export Service]
    Export -->|Writes| Sheets[Google Sheets API]
```

## 2.3 Directory Structure Analysis

### `src/config.ts` (The Central Nervous System)
This file is the single source of truth for the application's state.
- **Responsibility:** Loads `process.env`, validates it against a strict `Zod` schema, and exports a typed `config` object.
- **Validation Rules:** Checks for valid Cron expressions, numeric ports, and defaults.
- **Safety:** Crashes immediately on invalid config, preventing undefined runtime behavior.

### `src/web/` (The Presentation Layer)
- **`server.ts`**: The Express application entry point. Sets up middleware, static file serving (`/static` -> `src/web/public`), and API routes.
- **`views/`**: Server-side EJS templates. Logic is kept minimal: iterating over data and rendering basic HTML structures.
- **`public/`**: Client-side assets.
    - **`js/main.js`**: Handles **Progressive Enhancement**. Adds debounce to search, client-side validation, and interactive feedback (e.g., loading cursors) to static forms.
    - **`css/`**: A tiered CSS architecture (`reset`, `variables`, `layout`, `components`, `utilities`) ensuring a consistent Design System without heavy frameworks like Tailwind or Bootstrap.

### `src/core/` (Shared Utilities)
- **`browser.ts`**: **CRITICAL**. Manages the Playwright browser instance.
    - Implements the **Singleton Pattern** to prevent resource exhaustion.
    - Includes **Signal Handlers** (SIGINT/SIGTERM) to kill zombie browser processes.
    - Applies `puppeteer-extra-plugin-stealth` to evade bot detection.
- **`rateLimit.ts`**: Implements a generic `Retry` mechanism (`withRetry<T>`) with exponential backoff.
- **`brandFilter.ts`**: The noise reduction engine. Uses "Balanced Mode" logic to distinguish "Matiks" (brand) from "mathematics" (generic).

### `src/db/` (Persistence Layer)
- **`schema.ts`**: Database definitions.
    - **WAL Mode:** Enables Write-Ahead Logging for high concurrency (Dashboards read while Scrapers write).
    - **Tables:** `mentions`, `reviews`, `scrape_logs`, `scrape_cursors`.
    - **`queries.ts`**: Data Access Object (DAO) layer using Prepared Statements for security and speed.

### `src/core/googleSheets.ts` (Export Layer)
- **Responsibility:** Handles authentication (JWT) and synchronization with Google Sheets API v4.
- **Logic:** Performs a full "Clear & Replace" operation to ensuring the Sheet is an exact mirror of the database.

## 2.4 Frontend Architecture
The system employs a **Server-Side Rendered (SSR)** architecture with **Progressive Enhancement**.

- **Structure:** `Express` renders `EJS` templates. The browser receives fully formed HTML (SEO-friendly, fast First Contentful Paint).
- **Interactivity:** A specialized vanilla script (`main.js`) attaches listeners to search inputs and forms.
    - **Debounce:** Search inputs wait 600ms before auto-submitting.
    - **State:** URL Query Parameters (`?search=foo&offset=50`) drive the state. The browser URL is the single source of truth, enabling easy bookmarking and sharing.
- **Responsiveness:**
    - **Mobile-First CSS:** The dashboard uses CSS Grid and Flexbox with media queries to adapt from 4-column desktop layouts to single-column mobile stacks.
    - **Fluidity:** No fixed heights. Content flows naturally, ensuring accessibility on tablets and phones.

---

# 3. Part II: Automation & Site Reliability (SRE)

## 3.1 The Automation Engine
Centralized in `src/scheduler/jobs.ts`, using the Node.js event loop instead of OS cron.
- **Schedules:** defined in `.env` (Default: Every 3-4 hours).
- **Concurrency Control:** Uses an in-memory `Set<string>` as a Mutex. If "Reddit Job" is already running, a second trigger is skipped to prevent memory explosions.

## 3.2 Error Recovery Hierarchy
We classify errors into three levels:

### Level 1: Transient Item Error (Low Severity)
- **Example:** A single review has malformed HTML.
- **Action:** Log warning, skip item, continue batch.
- **Impact:** 1 lost item.

### Level 2: Network/Scraper Error (Medium Severity)
- **Example:** Reddit API returns 503 Service Unavailable.
- **Action:**
    1.  `RateLimiter` catches error.
    2.  Wait for Backoff (e.g., 5 seconds).
    3.  Retry request (Max 3 attempts).
    4.  If all fail, abort *this* scraper run but keep app alive.
- **Impact:** Scrape delayed by one cycle.

### Level 3: Process Crash (Critical Severity)
- **Example:** Memory leak, Unhandled Exception.
- **Action:**
    - Global `uncaughtException` handler logs stack trace to `logs/fatal.log`.
    - Process exits with code 1.
    - External Manager (PM2/Docker) restarts the service.

## 3.3 Browser Life-Support
Headless browsers often become "Zombies" (detached processes).
- **Protection:** `src/core/browser.ts` monitors the parent process.
- **Cleanup:** On shutdown, it forcefully closes all Browser Contexts.
- **Timeout:** 60-second limit on page loads triggers an automatic abort and cleanup.

---

# 4. Part III: Deployment & Operations

## 4.1 Recommended Strategy: PM2
PM2 is the production standard for Node.js process management.

**Setup Instructions:**
```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name matiks-monitor
pm2 save && pm2 startup
```
**Benefits:**
- **Auto-Restart:** Immediately revives the process if it crashes.
- **Log Management:** Handles log rotation and aggregation.
- **Monitoring:** Provides CPU/Memory stats via `pm2 monit`.

## 4.2 Alternative: Docker
For containerized environments (Kubernetes/AWS ECS).
```dockerfile
FROM node:18-slim
RUN npx playwright install-deps
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "dist/index.js"]
```

## 4.3 Database Maintenance
The SQLite database (`data/matiks.db`) is a single file.
- **Backup:** Copy the file (safe even while running due to WAL mode).
- **Restore:** Simply overwrite the file and restart the process.

---

# 5. Part IV: Future Architecture & Roadmap

## 5.1 Why excluded Twitter & LinkedIn?
See *Platform Constraints Analysis*.
- **Technical Barrier:** Aggressive TLS fingerprinting, CAPTCHAs (Arkose Labs), and IP bans.
- **Legal Barrier:** Violation of Terms of Service without Enterprise API (starting at $42k/mo).
- **Decision:** Removed from core codebase to ensure 100% stability. Future integration requires Enterprise API keys or 3rd party vendors (BrightData).

## 5.2 Generative AI Integration (Phase 2)
Transitioning from deterministic lexicons to probabilistic LLMs.
- **Advanced Sentiment:** Use OpenAI/Claude API to detect sarcasm.
- **Aspect-Based Analysis:** "Great UI but bad login" -> `UI: Positive`, `Stability: Negative`.
- **Auto-Reply Drafts:** Generating context-aware responses for store reviews.

## 5.3 Distributed Scaling (Phase 3)
Moving beyond the Monolith.
- **Queue System:** Replace internal scheduler with **Redis + BullMQ**.
    - Allows multiple "Worker Nodes" to scrape in parallel.
- **Database:** Migrate `src/db/queries.ts` to use **PostgreSQL + TimescaleDB** for handling millions of rows.
- **Proxy Rotation:** Integrate BrightData SDK for automatic IP rotation on 429 errors.

---

# 6. Conclusion
The Matiks Monitor is built on a foundation of reliability. By combining strict type safety, self-healing automation, and a modular architecture, it provides a stable platform for brand intelligence today, with a clear path to AI-driven insights tomorrow.
