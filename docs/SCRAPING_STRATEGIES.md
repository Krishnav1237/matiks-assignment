# Scraping Strategies & Counter-Measures

> **Context**: Matiks Social Media Monitor
> **Module**: Core Scraper Engine
> **Focus**: Anti-Detection, Algorithms, and Platform-Specific Logic

This document details the adversarial engineering strategies employed in the Matiks Monitor to reliably extract data from hostile environments (modern social media platforms). It covers our "Stealth Protocol," rate limiting mathematics, and the specific DOM warfare tactics used for each supported platform.

## 1. The Stealth Protocol

Modern anti-bot systems (Cloudflare Turnstile, Akamai, PerimeterX) fingerprint the browser environment to distinguish between human users and automation frameworks like Playwright/Puppeteer. Our system implements a multi-layer stealth protocol to mimic human signatures.

### 1.1 Browser Fingerprint Spoofing
We do not use the default Playwright context. Instead, we manually reconstruct the browser environment properties in `src/core/browser.ts`.

#### The `navigator` Object
Automation frameworks leave obvious traces in the `window.navigator` object. We overwrite these via `page.addInitScript()` before any page loads:

1.  **`navigator.webdriver`**:
    *   *Default*: `true` (Instant ban trigger).
    *   *Our Override*: `undefined` (or `false`).
    *   *Method*: We use `Object.defineProperty` to make it non-configurable and non-enumerable, mimicking a native property deletion.

2.  **`navigator.hardwareConcurrency`**:
    *   *Default*: Often matches the VM/Container vCPU count (e.g., 1 or 2).
    *   *Risk*: Low core counts (1) are highly correlated with AWS/GCP instances.
    *   *Our Override*: Random selection from `[4, 8, 12, 16]`.

3.  **`navigator.deviceMemory`**:
    *   *Default*: Often minimal in CI/CD environments.
    *   *Our Override*: Random selection from `[4, 8]` (GB).

4.  **`navigator.plugins`**:
    *   *Default*: Empty in headless Chrome.
    *   *Our Override*: We inject a mock `PluginArray` containing standard extensions:
        *   "PDF Viewer"
        *   "Chrome PDF Viewer"
        *   "Native Client"

### 1.2 Network Signature
1.  **User-Agent Rotation**:
    *   We do not use a fixed User-Agent.
    *   We utilize a list of modern User-Agents (Chrome/Firefox/Safari on macOS and Windows).
    *   The `navigator.platform` override is aligned with the chosen User-Agent.

### 1.3 Viewport Randomization
Bot frameworks default to `800x600` or `1280x720`. Anti-bot scripts check for exact dimensions.
*   We randomly choose from a list of common resolutions (e.g., 1366x768, 1536x864, 1440x900, 1280x720).

## 2. Human Behavior Algorithm (`src/core/humanize.ts`)

A perfect browser fingerprint will still get banned if the interaction pattern is robotic (instant clicks, zero reaction time). We implement a "Humanizer" engine.

### 2.1 Typing Simulation (`humanType`)
Never use `element.fill()`. It fires events too quickly (`input` -> `change` -> `blur` in milliseconds).
Instead, we use a stochastic typing algorithm:

1.  **Keystroke Latency**:
    *   We define a base latency and add per-character random jitter.
    *   We also introduce occasional longer pauses to mimic “thinking” time.

2.  **Typo Injection**:
    *   With a low probability (`~1%`), the typer hits a random adjacent key.
    *   It then waits (`reaction_time`), hits backspace (`correction`), and types the correct key.

### 2.2 Mouse Movement (Bezier Curves)
Robots move mouse pointers in straight lines (Point A to Point B). Humans move in arcs.
*   We calculate a quadratic Bezier curve between start and end points with randomized control points.

### 2.3 Session Warm-up
Before navigating to a login page or search bar, the scraper:
1.  Scrolls down a few pixels.
2.  Pauses.
This "entropy" generates a history of `mousemove` and `scroll` events `trusted=true` in the browser event buffer, which some anti-bot scripts analyze validation.

## 3. Rate Limiting Strategy (`src/core/rateLimit.ts`)

We implement a **Token Bucket** algorithm with **Exponential Backoff**.

### 3.1 Token Bucket Logic
*   **Capacity (B)**: Max burst size.
*   **Refill Rate (R)**: Tokens added per second.
*   **Current Tokens (T)**: `min(B, T_prev + (time_delta * R))`
*   Every request subtracts 1 token.
*   If `T < 1`, the thread sleeps for `(1 - T) / R` seconds.

**Configured Limits**:
*   *Reddit*: ~4 requests/minute
*   *Twitter*: ~2 requests/minute
*   *LinkedIn*: ~1.5 requests/minute
*   *Google Play*: ~12 requests/minute
*   *Apple App Store*: ~12 requests/minute

The limiter starts with a small burst (tokens) and refills based on the RPM rate above, with exponential backoff on failures.

### 3.2 Adaptive Jitter
We never sleep for exact intervals.
`sleep_time = calculated_delay * (1 + (Math.random() * 0.2))`
This 20% jitter prevents "synchronous waves" of traffic if multiple scrapers were running in parallel.

## 4. Platform-Specific Tactics

### 4.1 Reddit (`src/scrapers/reddit.ts`)
*   **Target**: `reddit.com/search.json` (public JSON endpoint)
*   **Why**: The JSON endpoint is lightweight and stable for keyword searches without requiring official API keys.
*   **Pagination**: Handled via the `after` token returned in the response.
*   **Anti-Bot**: Minimal. We include a realistic User-Agent and rate limiting.

### 4.2 Twitter / X (`src/scrapers/twitter.ts`)
*   **Target**: `twitter.com/search`
*   **Challenge**: Heavily obfuscated React classes (CSS Modules like `.r-18u3705`).
*   **Solution**: We rely on **Test IDs** (`data-testid="tweet"`, `data-testid="User-Name"`). These are attributes added by Twitter devs for their own testing, and they are surprisingly stable compared to CSS classes.
*   **Auth**: Twitter forces login for search.
    *   We perform a "Login Ceremonial": Navigate -> Wait -> Type User -> Wait -> Type Pass.
    *   **2FA**: If prompted for email/phone, the scraper pauses (or fails gracefully in MVP).
    *   **Cookie Persistence**: CRITICAL. We save cookies after login. Subsequent runs restore cookies. If cookies work, we bypass the dangerous login screen entirely.

### 4.3 LinkedIn (`src/scrapers/linkedin.ts`)
*   **Challenge**: The most aggressive anti-bot environment. Frequent "Security Checks" (CAPTCHA).
*   **Strategy**:
    1.  **Low Frequency**: We only scrape twice a day.
    2.  **Feed Scraping**: We scrape the global search feed for content, not user profiles. Profile scraping triggers stricter limits.
    3.  **URN Extraction**: We extract the unique URN `urn:li:activity:123456` from the DOM `data-urn` attribute to ensure unique IDs in our database.

### 4.4 Google Play Store (`src/scrapers/playstore.ts`)
*   **Approach**: Hybrid. We use `google-play-scraper` for bulk review retrieval and a Playwright fallback to capture any additional reviews.
*   **Why**: The scraper library is significantly faster for high-volume pulls, while the browser pass improves coverage.
*   **Strategy**: We paginate across multiple sort orders (newest, rating, helpfulness) and de-duplicate by review ID.

### 4.5 Apple App Store (`src/scrapers/appstore.ts`)
*   **Target**: Apple's Public RSS Feed (`itunes.apple.com/rss/...`) plus Playwright scraping for key countries.
*   **Advantage**: RSS provides a stable, no-auth feed; browser scraping supplements coverage.
*   **Limitation**: RSS is paginated per region and limited in depth, so we iterate many countries and pages.
*   **Workaround**: We loop through a broad list of countries and then scrape the top regions (US/GB/IN) in the browser.

## 5. Handling Captchas & Blocks

In this MVP, we employ a **"Fail Fast & Backoff"** strategy for CAPTCHAs.

### 5.1 Detection
We detect blocks by platform-specific failures (unexpected login screens, verification prompts, or 429 rate limits).

### 5.2 Response
When a block is detected:
1.  **Abort**: The scraper fails gracefully for that run.
2.  **Log**: The event is logged with high priority.
3.  **Cool-down**: The rate limiter applies exponential backoff to reduce retry pressure.

## 6. Data Integrity & Deduplication

Scraping is messy. We ensure clean data via:

### 6.1 Idempotency keys
*   **Twitter**: Tweet ID (e.g., `186728399182`)
*   **Reddit**: Thing ID (e.g., `t3_xyz123`)
*   **LinkedIn**: Activity URN (e.g., `78291028391`)

We rely on the database `UNIQUE(platform_id, external_id)` constraint. We utilize `INSERT OR IGNORE` logic. This allows us to scrape overlapping windows (e.g., "scrolling back 5 pages") without filling the DB with duplicates.

### 6.2 Sentiment Consistency
We re-calculate sentiment on every scrape. Since we use a deterministic local lexicon algorithm, the score for a specific text is constant. This ensures reproducibility.

---
*End of Scraping Strategies Document*
