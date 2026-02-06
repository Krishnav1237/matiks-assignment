# Matiks Social Media Monitor: Technical System Specification

## 1. Executive Summary
This document provides a comprehensive technical overview of the Matiks Social Media Monitor, an automated intelligence gathering system designed to aggregate, analyze, and persist brand mentions and customer feedback from disparate external sources. The system is engineered for autonomous operation, utilizing advanced browser automation and algorithmic incremental data fetching to ensure high-fidelity data capture with minimal resource overhead.

## 2. System Architecture

### 2.1 Core Runtime Environment
The system is built upon a **Node.js (v20+)** runtime environment, selected for its non-blocking I/O capabilities which are critical for concurrent data ingestion operations. The architecture follows a modular service-oriented design pattern within a monolithic repository, ensuring ease of deployment and maintainability.

- **Language**: TypeScript 5.0+ (Strict Mode enabled for type safety).
- **Process Management**: Single-process event loop with offloaded child processes for browser instance management via Playwright.

### 2.2 Data Persistence Layer
Data persistence is handled by a local **SQLite** database operating in Write-Ahead Logging (WAL) mode. This architectural choice provides ACID compliance, zero-configuration deployment, and sufficient throughput for the projected data volume (10k+ records/month) without the operational complexity of a networked database cluster.

- **Schema Design**: Relational model enforcing strict integrity constraints on `platforms`, `mentions`, `reviews`, and `scrape_logs`.
- **Concurrency**: `better-sqlite3` driver providing synchronous execution for data integrity and high-performance synchronous reads.

## 3. Data Ingestion Pipelines

The system implements three distinct ETL (Extract, Transform, Load) pipelines, each optimized for the specific technical constraints of its target platform.

### 3.1 Reddit Ingestion Pipeline
*Target: `old.reddit.com`*

- **Extraction Strategy**: Hybrid DOM Parsing. Utilization of the legacy Reddit frontend minimizes DOM complexity and network payload size compared to the modern SPA (Single Page Application) interface.
- **Incremental Logic**:
    - **Cron Schedule**: `0 */4 * * *` (Every 4 hours).
    - **Query Optimization**: Time-boxed queries (`time=day`, `time=week`) reduce the search space to `O(k)` where `k` is the number of recent items, rather than `O(n)` of the entire history.
- **Anti-Detection**: Implementation of `puppeteer-extra-plugin-stealth` adapted for Playwright to neutralize fingerprinting vectors (e.g., `navigator.webdriver`, WebGL vendor masking).

### 3.2 Google Play Store Ingestion Pipeline
*Target: Public Store Listing Queries*

- **Extraction Strategy**: Dual-Mode Hybrid.
    - **Primary (API)**: Direct HTTP requests using `google-play-scraper` for high-throughput metadata retrieval.
    - **Fallback (Browser)**: Headless Chromium instance instantiation is strictly conditional, triggered only upon API failure or stale data detection (>24h latency).
- **Deduplication Algorithm**: A `Set<string>` based look-aside buffer containing the last 1,000 processed IDs is utilized to enforce idempotency. Pagination terminates immediately upon detection of contiguous duplicate keys.

### 3.3 Apple App Store Ingestion Pipeline
*Target: Regional RSS Feeds*

- **Extraction Strategy**: XML Feed Parsing.
- **Resource Optimization**: This pipeline operates entirely via HTTP/1.1 requests, bypassing the browser stack completely. This reduces memory footprint by approximately 400MB per execution cycle compared to browser-based scraping.
- **State Management**: A persistent cursor (`last_item_date`) stored in the `scrape_cursors` table governs the temporal window for data ingestion, ensuring strictly incremental updates.

## 4. Natural Language Processing (NLP) Module

To achieve production-grade sentiment classification accuracy necessitates handling domain-specific linguistic nuances. The system moves beyond standard lexicographical analysis by implementing a domain-adapted scoring engine.

### 4.1 Sentiment Analysis Engine
The engine utilizes the **AFINN-165** valence-aware dictionary model, enhanced via a custom injection layer.

- **Library**: `sentiment` (Node.js).
- **Core Algorithm**: Tokenization $\rightarrow$ Stemming $\rightarrow$ Valence Summation $\rightarrow$ Normalization.
- **Domain Adaptation**: A specialized `Social Lexicon` interceptor modifies token scoring to account for high-variance internet vernacular:
    - **Slang Handling**: Quantified scoring for neologisms (e.g., "rug pull" = -4.0, "fire" = +3.0).
    - **Emoji Semantics**: Unicode parsing maps ideograms to sentiment values (e.g., 🔥 U+1F525 $\rightarrow$ +3.0).

## 5. System Reliability Engineering (SRE)

The system enforces strict operational guarantees through rigorous validation and lifecycle management.

### 5.1 Configuration Validation
Runtime configuration is governed by a **Zod** schema definition. This enforces a "Fail-Fast" startup sequence where the application process will terminate immediately with a non-zero exit code if:
- Required environment variables are missing.
- Type mismatches occur (e.g., alphabetical characters in port numbers).
- Business logic constraints are violated.

### 5.2 Process Lifecycle Management
To prevent resource leaks in containerized or daemonized environments, the system implements OS signal interception:
- **Signal Handling**: Listeners for `SIGINT` and `SIGTERM`.
- **Graceful Shutdown**: Upon signal receipt, the `BrowserManager` invokes strict cleanup routines to terminate all child Chromium processes before the main Node.js process exits.

### 5.3 Quality Assurance
- **Unit Testing**: `vitest` suite executes deterministic tests against the Sentiment Engine and Configuration modules.
- **Integration Testing**: End-to-End (E2E) verification scripts validate the complete data lifecycle from ingestion to persistence.

## 6. Functional Compliance Matrix

The following matrix formally explicitly maps client requirements to technical implementations.

| Requirement Specification | Implementation Status | Technical Artifact |
| :--- | :--- | :--- |
| **Reddit Monitoring** | **Compliant** | `src/scrapers/reddit.ts` |
| **App Store Aggregation** | **Compliant** | `src/scrapers/appstore.ts` |
| **Play Store Aggregation** | **Compliant** | `src/scrapers/playstore.ts` |
| **Autonomous Operation** | **Compliant** | `src/scheduler/jobs.ts` |
| **Data Visualization** | **Compliant** | Dashboard (`/src/web`) |
| **Search & Filtering** | **Compliant** | SQL Generator (`src/db/queries.ts`) |
| **Sentiment Analytics** | **Compliant** | NLP Engine (`src/pipeline/sentiment.ts`) |
| **Fault Tolerance** | **Compliant** | Retry Logic & Signal Handlers |
| **Configuration Standards** | **Compliant** | Zod Schema (`src/config.ts`) |

## 7. Operational Instructions

### 7.1 Deployment
The system is delivered as a self-contained Node.js module.
```bash
npm install   # Hydrate dependencies
npm run build # Transpile TypeScript
npm start     # Initialize Daemon
```

### 7.2 Observability
Operational status is exposed via the HTTP interface:
- **Dashboard**: `http://localhost:3000`
- **Health Check**: `GET /api/status`

---
*Document Version: 1.0.0 (Release)*
*Date: February 6, 2026*
