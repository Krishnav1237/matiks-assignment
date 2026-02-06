# Matiks Monitor: Scraping Intelligence & Strategy
> **Document ID:** SCRAPE-INTEL-V1
> **Scope:** Data Ingestion, Anti-Detection, Cursor Logic
> **Status:** Active & Verified

---

# 1. Introduction

This document details the "Brain" of the data ingestion engine. Unlike simple scripts that blindly fetch web pages, the Matiks Monitor employs **Stateful Incremental Scraping** and **Adversarial Avoidance** techniques to ensure long-term data quality and availability.

---

# 2. Universal Logic: The Incremental Cursor
To prevent duplicate data ingestion and minimize bandwidth, every scraper implements the Cursor Pattern.

## 2.1 The Problem
Stateless scrapers fetch the "Top 100" posts every hour. This results in:
- 95% Duplicate data (processed again and again).
- Wasted CPU/Bandwidth.
- Higher risk of bans (redundant requests).

## 2.2 The Solution: `scrape_cursors`
The database tracks the "high water mark" for every platform.
```typescript
interface ScrapeCursor {
  platform: string;           // e.g. 'reddit'
  last_item_date: string;     // ISO Timestamp of newest item seen
  last_item_ids: string[];    // Cache of last 100 IDs (Bloom Filter style)
}
```

## 2.3 The Algorithm
1.  **Fetch Batch:** Scraper gets latest 50 items.
2.  **Date Check:** Is `item.date <= cursor.last_item_date`?
    - If YES: We have reached known territory. **STOP SCRAPING**.
    - If NO: Process item.
3.  **Efficiency:** This reduces a typical run from 100 requests to just 1 or 2 (getting only what's new).

---

# 3. Adversarial Defense (Stealth)
Modern platforms (Reddit, Google) employ anti-bot measures (Cloudflare, fingerprinting).

## 3.1 Browser Fingerprint Masking
When falling back to Browser Scraping (Playwright), we apply `puppeteer-extra-plugin-stealth`:
- **Navigator Mocking:** Overwrites `navigator.webdriver` to `false`.
- **Runtime Mocking:** Injects fake `chrome.runtime` objects.
- **Hardware Fuzzing:** Randomizes `hardwareConcurrency` and `deviceMemory` values to look like varying consumer laptops.

## 3.2 Humanization Heuristics
- **Random Delays:** Never click instantly. Wait `Math.random() * 2000 + 500` ms.
- **Human Scrolling:** Use `humanScroll()` utility which varies scroll speed and pauses, mimicking a user reading content, rather than jumping to coordinates.

---

# 4. Platform Strategy: Reddit

## 4.1 Hybrid Architecture
The Reddit scraper is a hybrid engine designed to balance speed vs reliability.

### Mode A: JSON API (Speed)
- **Method:** Appending `.json` to search URLs. e.g. `reddit.com/search.json?q=matiks`.
- **Pros:** 100x faster, less CPU.
- **Cons:** Extremely aggressive Rate Limiting (429s).
- **Implementation:**
    - Uses a **Token Bucket** Rate Limiter.
    - Max 25 requests/min.
    - Strict Exponential Backoff on 429 (2s -> 4s -> 8s -> 16s).

### Mode B: Headless Browser (Reliability)
- **Trigger:** If API fails or returns suspicious "0 results".
- **Method:** Launches Chromium.
- **Challenge:** Reddit uses "Infinite Scroll".
- **Logic:** The scraper scrolls to the bottom, waits for the DOM to mutate (new posts loading), and repeats until the Cursor Date is reached.

## 4.2 Brand Filtering Rules
Raw search for "Matiks" is noisy.
- **Strict Mode:** Only matches exact Brand domain (`matiks.in`).
- **Balanced Mode (Default):** Matches "Matiks" **IF** context words exist (*app, game, math, play store, ios*). This eliminates false positives like "matiks" being a typo for "mathematics".

---

# 5. Platform Strategy: Google Play Store

## 5.1 The Hidden API
Google offers no public API. We use the private Protobuf/JSON RPC endpoints used by the Play Store frontend via `google-play-scraper`.

### Pagination Logic
- The API supports batches of ~150 reviews.
- We must request sorted by `NEWEST` to make our Cursor Logic work.
- **Dedup:** Play Store IDs are UUIDs. We check every UUID against our specific `last_item_ids` cache to catch overlaps even if timestamps are identical.

## 5.2 Browser Fallback
Google frequently changes signatures.
- **Fallback:** Playwright visits `play.google.com`.
- **Interaction:** Clicks "See All Reviews".
- **Injection:** Injects JavaScript to scroll the modal container (`.modal-scroller`) specifically, as window scrolling doesn't work on the overlay.

---

# 6. Platform Strategy: Apple App Store

## 6.1 The Geo-Fragmentation Problem
Apple segregates reviews by Country Store Front. A review in the UK store is invisible to the US store.

### The Polling Strategy
The scraper iterates through a priority list of markets:
1.  **Tier 1:** US, UK, CA, AU (English heavy).
2.  **Tier 2:** IN, DE, FR (Major markets).
3.  **Tier 3:** ES, IT, JP, etc.

## 6.2 Data Normalization
- **RSS Feeds:** Used for recent reviews (Last 50).
- **HTML Scraping:** Used for deep history.
- **ID Hashing:** Apple sometimes obscures Review IDs. We generate a deterministic hash `SHA1(author + date + content)` to create a surrogate Primary Key, ensuring we don't save the same review twice even if we scrape it from different sources.

---

# 7. Sentiment Analysis Pipeline

## 7.1 Deterministic Engine
We choose a local Lexicon-based engine over an API-based LLM for cost and speed.
- **Library:** `sentiment` (Node.js).
- **Speed:** < 1ms per post. No network latency.

## 7.2 The Social Lexicon
Standard English dictionaries fail on internet slang. We inject a custom `socialLexicon`:
- `"lit"`: +3 (Positive)
- `"buggy"`: -3 (Negative)
- `"trash"`: -4 (Strong Negative)
- `"gem"`: +3 (Strong Positive)

## 7.3 Sentiment Normalization
Raw scores are normalized to a `-1.0` to `1.0` scale for consistent graphing on the Dashboard.

---

# 8. Summary of Limits

| Platform | Request Limit | Backoff Strategy | Max Concurrent |
| :--- | :--- | :--- | :--- |
| **Reddit** | 25 / min | Exponential (2^n) | 1 |
| **Play Store** | 100 / min | Fixed (1 sec) | 1 |
| **App Store** | 60 / min | Fixed (1 sec) | 1 |

This configuration ensures the Matiks Monitor operates "Low and Slow", gathering data continuously without triggering platform defenses.
