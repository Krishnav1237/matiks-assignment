# Matiks Monitor: User Operations Manual & API Reference
> **Document ID:** USER-OPS-V1
> **Audience:** Analysts, Product Managers, Developers
> **Scope:** Dashboard Usage, Data Export, API Specs
> **Status:** Active

---

# 1. Getting Started

The Matiks Monitor is your sophisticated listening post for brand intelligence. This manual guides you through operating the dashboard, interpreting the data, and integrating the system with other tools.

## 1.1 Accessing the Interface
- **Local:** `http://localhost:3000`
- **Server:** `http://<your-server-ip>:3000`
- **Mobile/Tablet:** The dashboard is fully responsive. Access it from your phone's browser while on the corporate VPN/Wi-Fi to check stats on the go.

---

# 2. The Command Dashboard

## 2.1 The "Overview" (Mission Control)
The home page provides an at-a-glance health check of your brand.

### Intelligence Cards
- **Total Mentions:** The lifetime count of every time "Matiks" has been discussed on Reddit.
- **Total Reviews:** Cumulative feedback from both Google Play and App Store.
- **Last 24h Pulse:** The most critical metric. A sudden spike here usually indicates an incident (e.g., app crash) or a viral moment.

### Visual Analytics
- **Sentiment Distribution Table:**
    - Breaks down mentions by `Positive`, `Neutral`, `Negative`.
    - **Usage:** If the `Negative` column for Reddit is high (Red), click into the Mentions tab immediately to investigate.
- **Star Rating Table:**
    - Compare Google Play vs App Store performance side-by-side.
    - **Avg Rating:** A real-time calculation of your current app health.

### System Health
- **Recent Scrape Logs:**
    - Shows the last 10 automated jobs.
    - **Status Indicators:**
        - 🟢 **Success:** New data found (or verified no new data).
        - 🟡 **Running:** Job is currently active.
        - 🔴 **Failed:** Job encountered a critical error (hover to see why).

## 2.2 The "Mentions" Console (Social Listening)
This is your search engine for social content.

### Advanced Filtering
- **Search Dynamics (Auto-Search):** Just start typing. The system waits for you to pause (600ms) before automatically refreshing the results. No need to hit "Enter".
- **Sentiment Filter:** Isolate "Negative" posts to find frustrated users. Isolate "Positive" posts for marketing testimonials.
- **Context Search:** Search for keywords like "crash", "login", "price", or "love". Search applies to both the post content and the author's name.
- **Date Range:** Drill down into specific marketing campaign windows.

### Seamless Navigation
- **Pagination:** Smoothly browse through thousands of mentions with centered, easy-to-hit controls at the bottom of the page.
- **Deep Linking:** Every filter you apply updates the URL. Copy the link to share a specific view (e.g., "Positive Reddit posts about 'pricing'") with your team.

### The Feed
- **Sentiment Badge:** Each post is tagged by our AI.
- **Direct Links:** Clicking the title takes you directly to the original Reddit thread for context.

## 2.3 The "Reviews" Console (App Feedback)
Aggregates feedback from both mobile stores into a single stream.

### Power User Workflows
- **Find Bugs:** Filter for `Rating < 3` AND Search for "bug".
- **Version Check:** Filter by `App Version` (e.g., "2.1.4") to see if the latest hotfix solved user complaints.

---

# 3. Data Liberation (Exports) :unlock:

Data is not useful if it's trapped. We provide instant **Universal CSV Export**.

## 3.1 Context-Aware Export
The "Export to CSV" button is smart. It respects your current filters.
- *Scenario:* You filter the Reviews page for "1 Star" ratings in "Last 30 Days".
- *Action:* You click "Export CSV".
- *Result:* The file contains **only** those specific 1-star reviews. This is perfect for sending a "Bug Report" spreadsheet to your engineering team.

## 3.2 CSV Specification
Standard RFC-4180 format.
- **Columns:** Date, Platform, Author, Rating/Sentiment, Content, Version/URL, Likes/Helpful.

---

## 3.3 Google Sheets Sync (API) [Beta]

For those who prefer live spreadsheets over static CSVs, the system provides a programmatic sync.

**Logic**:
- The API reads your `.env` credentials.
- It clears the target sheet (Mentions or Reviews) and re-uploads the full dataset from the database.
- This is an **Overwrite** operation, not an append, ensuring your Sheet is always a 1:1 mirror of the database.

**How to Trigger**:
Since this is a heavy operation, it is currently API-only to prevent accidental abuse.

**Sync Mentions:**
```bash
curl "http://localhost:3000/api/export/sheets?type=mentions"
```

**Sync Reviews:**
```bash
curl "http://localhost:3000/api/export/sheets?type=reviews"
```

---

# 4. Developer API Reference


For engineers who want to build their own visualizations or integrate data into internal Dashboards (Grafana, Retool).

**Base URL:** `http://localhost:3000/api/`

## 4.1 Stats & Metrics
### `GET /api/stats`
Returns the raw numbers behind the Overview page.
```json
{
  "mentions": [
    { "platform": "reddit", "total": 1240, "avg_sentiment": -0.15 }
  ],
  "last24h": { "mentions": 12, "reviews": 3 }
}
```

## 4.2 Data Query Endpoints
### `GET /api/mentions`
**Query Params:**
- `limit`: (int) Max results (default 50).
- `offset`: (int) Pagination.
- `sentiment`: (string) 'positive' | 'negative'.
- `search`: (string) Keyword.

### `GET /api/reviews`
**Query Params:**
- `platform`: 'playstore' | 'appstore'.
- `rating`: (int) 1-5.
- `version`: (string) App version.

## 4.3 System Status
### `GET /api/status`
Used for Uptime Monitors (e.g., Pingdom).
**Response:**
```json
{
  "uptimeSeconds": 84020,
  "schedules": [
    { "name": "Reddit Scraper", "cron": "0 */4 * * *", "nextRun": "..." }
  ]
}
```

---

# 5. Configuration & Tuning

## 5.1 Environment Variables
Located in `.env`.
- **Search Terms:** `SEARCH_TERMS` covers the keywords we look for.
- **Brand Rules:** `BRAND_STRICT=true` prevents "balanced" context checks (useful if you only want to find your exact domain).

## 5.2 Scrape Frequency
Controlled by standard Cron syntax.
- **Default:** `0 */4 * * *` (Every 4 hours).
- **Recommendation:** Do not increase frequency beyond `*/1` (Hourly). It adds no value (social conversations move slowly) and increases ban risk.

---

# 6. Troubleshooting Guide

### Issue: "Google Sheets Export Failed"
1.  **Check JSON Path:** Ensure `GOOGLE_SERVICE_ACCOUNT_JSON` points to a valid file. Use a full absolute path if the relative path fails.
2.  **Check Permissions:** Open your Google Sheet -> Click "Share" -> specific the `client_email` from your JSON file as an **Editor**. The service account cannot write to your personal sheet unless you invite it.

### Issue: "No Data Found"
1.  **Check Logs:** Go to the "System Logs" tab. Are there Red "Failed" entries?
2.  **Check Start Date:** The scraper runs *forward* from the moment you turn it on. For historical data, it scrapes backward until it hits a limit or rate limit.
3.  **Check Keywords:** Is `BRAND_STRICT` on? "Matiks" (without .in) might be getting filtered out.

### Issue: "Scraper Failed (503 / 429)"
1.  **Relax:** This is normal. The internet is flaky.
2.  **Wait:** The system's **Retry Logic** will automatically try again in the next cycle.
3.  **Persist:** If it persists for >24h, check if your server IP is blacklisted (try running from a local machine to compare).
