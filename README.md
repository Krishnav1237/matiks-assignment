# Matiks Social Media Monitor

> **Comprehensive Brand Monitoring & Review Aggregation System**

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node: 20+](https://img.shields.io/badge/Node-20%2B-green.svg)
![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)

The **Matiks Social Media Monitor** is a production-grade Minimum Viable Product (MVP) designed to autonomously track brand presence across the web. It combines browser automation (Playwright) with public endpoints to scrape, analyze, and visualize data from Reddit, Google Play Store, and the Apple App Store.

This system is built for **local execution**, reliability, and simplicity. It requires no complex container orchestration or external database clusters—just Node.js.
It also **does not require official API keys** for supported platforms.

## 📚 Documentation
- [Technical Architecture](./docs/TECHNICAL_ARCHITECTURE.md) - Deep dive into system design, DB schema, and components.
- [Scraping Strategies](./docs/SCRAPING_STRATEGIES.md) - Details on anti-detection, rate limiting, and stealth.
- [Task List](./task.md) - Project status and completed milestones.

---

## 🚀 Key Features

### 🌐 Multi-Platform Monitoring
- **Reddit**: Monitors subreddits and keyword searches via `old.reddit.com`.

- **Google Play Store**: Aggregates user reviews, ratings, and version data.
- **Apple App Store**: Aggregates global reviews via regional RSS feeds.

### 🧠 Intelligent Processing
- **Local Sentiment Analysis**: Uses the AFINN-165 lexicon to classify every mention as Positive, Neutral, or Negative.
- **Human Behavior Simulation**: Scrapers use random typing delays, mouse curves, and scrolling to mimic real users.
- **Smart Rate Limiting**: Token-bucket algorithm prevents bans by throttling requests automatically.

### 📊 Visualization & Data
- **Dark Theme Dashboard**: Overview of stats, sentiment trends, and recent activity.
- **Data Filtering**: Filter by platform, date range, sentiment score, or keyword.
- **CSV Export**: One-click export of all datasets for external analysis (Excel/Tableau).
- **Google Sheets Export**: Optional full replacement export for mentions and reviews.
- **Status API**: `/api/status` for scheduler visibility, recent logs, and rate-limit state.

---

## 🛠️ Prerequisites

*   **OS**: macOS, Linux, or Windows (WSL2 recommended).
*   **Node.js**: Version 20.0 or higher.
*   **npm**: Installed with Node.js.
*   **Hardware**: Minimum 4GB RAM (8GB recommended for concurrent browser sessions).

---

## 📥 Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/your-org/matiks-monitor.git
    cd matiks-monitor
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```
    *This will install all Node.js packages and local type definitions.*

3.  **Install Browsers**
    ```bash
    npx playwright install chromium
    ```
    *This downloads the dedicated Chromium binary used for scraping.*

4.  **Configure Environment**
    Copy the example file to `.env`:
    ```bash
    cp .env.example .env
    ```

5.  **Initialize Database**
    ```bash
    npm run db:init
    ```
    *Creates the `data/matiks.db` SQLite file and runs schema migrations.*

---

## ⚙️ Configuration

Open `.env` in your editor. This file controls the entire system.

### Core Settings
| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Web server port | `3000` |
| `LOG_LEVEL` | Logging verbosity | `info` or `debug` |
| `SEARCH_TERMS` | Comma-separated monitoring keywords | `matiks,matiks app,matiks.ai` |
| `BRAND_REQUIRED_TERMS` | Required brand anchors (only mentions containing these are stored) | `matiks.in,matiks.com` |
| `BRAND_STRICT` | Strict anchor-only filtering (`true` recommended) | `true` |
| `BRAND_BALANCED` | If strict is false, keep only "matiks" with app/game/math context | `true` |
| `BRAND_SUBREDDITS` | Subreddits where all posts/comments are saved | `matiks` |
| `HEADLESS` | Run browser in headless mode (set `false` for visible testing) | `true` |
| `SLOWMO` | Add Playwright slow motion (ms per action) | `0` |

### App Store IDs
*Required for review scraping.*
| Variable | Description | How to find it |
|----------|-------------|----------------|
| `PLAYSTORE_APP_ID` | Package name | URL `id=com.example.app` part |
| `APPSTORE_APP_ID` | Numerical App ID | URL `/id123456789` part |



### Scheduling (Cron)
Configure how often each scraper runs. Uses standard Cron syntax.
```ini
# Run Reddit every 4 hours
REDDIT_CRON="0 */4 * * *"

```
If credentials or app IDs are missing, those jobs are skipped instead of repeatedly failing.

### Scraper Tuning (Safety Defaults)
You can keep defaults for safety. These control scroll depth and pacing:


---

## 🖥️ Usage Guide

### Starting the System (Daemon Mode)
This is the standard mode. It starts the **Web Server** and the **Scheduler** simultaneously.
```bash
npm start
```
*   **Dashboard**: `http://localhost:3000`
*   **Scheduler**: Runs in background, triggering jobs according to Cron config.
*   **Logs**: Streamed to console and written to `logs/app.log`.

### Manual Scraping (CLI)
You can trigger individual scrapers manually for testing or immediate data updates.

**Run All Scrapers:**
```bash
npm run scrape:all
```

**Run Specific Platform:**
```bash
npm run scrape:reddit

npm run scrape:playstore
npm run scrape:appstore
```

---

## 🔍 Troubleshooting



### 2. "Rate Limit Exceeded" or "429 Too Many Requests"
**Cause**: You possess scraped too aggressively.
**Fix**:
*   Increase the cron interval in `.env` (e.g., from every 1 hour to every 6 hours).
*   Add a Proxy configuration to `.env`.
*   The system includes automatic backing off—it will pause for a while before trying again.

### 3. "Database Locked"
**Cause**: SQLite file is being accessed by too many processes (rare with WAL enabled).
**Fix**:
*   Ensure you don't have the sqlite file open in a heavy GUI viewer while the scraper is running.
*   Restart the application to clear file locks.

### 4. Dashboard not loading / "Failed to lookup view"
**Cause**: The `dist` build folder is missing the EJS templates.
**Fix**:
*   Run `npm run build` again.
*   Or use `ts-node` via `npm run dev` (if configured) for development.

---

## 👨‍💻 Development

### Project Structure
*   `src/core`: Heavy lifting (Browser, Rate Limiter)
*   `src/scrapers`: Platform logic
*   `src/web`: Dashboard logic
*   `data`: Database storage

### Adding a New Scraper
1.  Create `src/scrapers/new_platform.ts`.
2.  Extend `BaseScraper`.
3.  Implement `beforeScrape()`, `scrapeData()`.
4.  Add to `src/db/schema.ts` (Platform enum).
5.  Register in `src/scrapers/run.ts` and `src/scheduler/jobs.ts`.

---

## 📄 License
This MVP is open-source software licensed under the **MIT license**.
