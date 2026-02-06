import cron from 'node-cron';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { RedditScraper } from '../scrapers/reddit.js';

import { PlayStoreScraper } from '../scrapers/playstore.js';
import { AppStoreScraper } from '../scrapers/appstore.js';
import { closeBrowser } from '../core/browser.js';

interface ScheduledJob {
  name: string;
  cron: string;
  runner: () => Promise<void>;
  enabled: boolean;
  task?: cron.ScheduledTask;
}



function hasPlayStoreConfig(): boolean {
  return !!process.env.PLAYSTORE_APP_ID;
}

function hasAppStoreConfig(): boolean {
  return !!process.env.APPSTORE_APP_ID;
}

const jobs: ScheduledJob[] = [
  {
    name: 'Reddit Scraper',
    cron: config.cron.reddit,
    runner: async () => {
      const scraper = new RedditScraper();
      await scraper.run();
    },
    enabled: true,
  },

  {
    name: 'Play Store Scraper',
    cron: config.cron.playstore,
    runner: async () => {
      const scraper = new PlayStoreScraper();
      await scraper.run();
    },
    enabled: hasPlayStoreConfig(),
  },
  {
    name: 'App Store Scraper',
    cron: config.cron.appstore,
    runner: async () => {
      const scraper = new AppStoreScraper();
      await scraper.run();
    },
    enabled: hasAppStoreConfig(),
  },
];

const runningJobs = new Set<string>();

export function startScheduler(): void {
  logger.info('Starting scheduler...');
  
  for (const job of jobs) {
    if (!job.enabled) {
      logger.warn(`Skipping ${job.name} (missing required configuration)`);
      continue;
    }

    if (!cron.validate(job.cron)) {
      logger.error(`Invalid cron expression for ${job.name}: ${job.cron}`);
      continue;
    }
    
    job.task = cron.schedule(job.cron, async () => {
      if (runningJobs.has(job.name)) {
        logger.warn(`[Scheduler] Skipping ${job.name} (previous run still active)`);
        return;
      }

      runningJobs.add(job.name);
      logger.info(`[Scheduler] Running: ${job.name}`);
      try {
        await job.runner();
        logger.info(`[Scheduler] Completed: ${job.name}`);
      } catch (error) {
        logger.error(`[Scheduler] Failed: ${job.name}`, { error });
      } finally {
        await closeBrowser();
        runningJobs.delete(job.name);
      }
    });
    
    logger.info(`Scheduled: ${job.name} (${job.cron})`);
  }
  
  logger.info('Scheduler started successfully');
  logger.info('Scheduled jobs:');
  jobs.forEach(job => {
    logger.info(`  - ${job.name}: ${job.cron}`);
  });
}

export function stopScheduler(): void {
  for (const job of jobs) {
    if (job.task) {
      job.task.stop();
    }
  }
  logger.info('Scheduler stopped');
}

// Helper to get next run time
export function getScheduleInfo(): Array<{ name: string; cron: string; enabled: boolean }> {
  return jobs.map(job => ({
    name: job.name,
    cron: job.cron,
    enabled: job.enabled,
  }));
}
