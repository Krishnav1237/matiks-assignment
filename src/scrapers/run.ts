import { RedditScraper } from './reddit.js';
import { PlayStoreScraper } from './playstore.js';
import { AppStoreScraper } from './appstore.js';
import { closeBrowser } from '../core/browser.js';
import { logger } from '../core/logger.js';

type ScraperName = 'reddit' | 'playstore' | 'appstore' | 'all';

async function runScraper(name: ScraperName) {
  logger.info(`Running scraper: ${name}`);
  
  try {
    switch (name) {
      case 'reddit': {
        const scraper = new RedditScraper();
        await scraper.run();
        break;
      }

      case 'playstore': {
        const scraper = new PlayStoreScraper();
        await scraper.run();
        break;
      }
      case 'appstore': {
        const scraper = new AppStoreScraper();
        await scraper.run();
        break;
      }
      case 'all': {
        // Run all scrapers sequentially
        const scrapers = [
          { name: 'Reddit', fn: () => new RedditScraper().run() },
          { name: 'Play Store', fn: () => new PlayStoreScraper().run() },
          { name: 'App Store', fn: () => new AppStoreScraper().run() },
        ];
        
        for (const scraper of scrapers) {
          logger.info(`\n${'='.repeat(50)}`);
          logger.info(`Running ${scraper.name} scraper...`);
          logger.info('='.repeat(50));
          
          try {
            await scraper.fn();
          } catch (error) {
            logger.error(`${scraper.name} scraper failed: ${error}`);
          }
        }
        break;
      }
      default:
        logger.error(`Unknown scraper: ${name}`);
        process.exit(1);
    }
  } finally {
    await closeBrowser();
  }
}

// CLI entry point
const scraperName = process.argv[2] as ScraperName;

if (!scraperName) {
  console.log('Usage: npm run scrape:<platform>');
  console.log('Platforms: reddit, playstore, appstore, all');
  process.exit(1);
}

runScraper(scraperName)
  .then(() => {
    logger.info('Scrape completed');
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Scrape failed: ${error}`);
    process.exit(1);
  });
