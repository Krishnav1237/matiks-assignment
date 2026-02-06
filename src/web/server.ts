import express from 'express';
import path from 'path';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { getMentions, getReviews, getStats, getRecentLogs, MentionFilters } from '../db/queries.js';
import { GoogleSheetsService } from '../core/googleSheets.js';
import { getScheduleInfo } from '../scheduler/jobs.js';
import { getRateLimitState } from '../core/rateLimit.js';

const app = express();

// Configure EJS
app.set('view engine', 'ejs');
app.set('views', config.paths.views);

// Static files
app.use('/static', express.static(path.join(config.paths.root, 'src', 'web', 'public')));

// JSON parsing
app.use(express.json());

// Dashboard home
app.get('/', (req, res) => {
  const stats = getStats();
  const recentLogs = getRecentLogs(10);
  const recentMentions = getMentions({ limit: 5 });
  const recentReviews = getReviews({ limit: 5 });
  
  res.render('dashboard', {
    title: 'Matiks Monitor',
    stats,
    recentLogs,
    recentMentions,
    recentReviews,
  });
});

// Mentions page
app.get('/mentions', (req, res) => {
  const filters: MentionFilters = {
    platform: req.query.platform as MentionFilters['platform'],
    sentiment: req.query.sentiment as string | undefined,
    search: req.query.search as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit: 50,
    offset: parseInt(req.query.offset as string) || 0,
  };
  
  const mentions = getMentions(filters);
  
  res.render('mentions', {
    title: 'Social Mentions - Matiks Monitor',
    mentions,
    filters,
  });
});

// Reviews page
app.get('/reviews', (req, res) => {
  const filters = {
    platform: req.query.platform as 'playstore' | 'appstore' | undefined,
    rating: req.query.rating ? parseInt(req.query.rating as string) : undefined,
    sentiment: req.query.sentiment as string | undefined,
    search: req.query.search as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit: 50,
    offset: parseInt(req.query.offset as string) || 0,
  };
  
  const reviews = getReviews(filters);
  
  res.render('reviews', {
    title: 'App Reviews - Matiks Monitor',
    reviews,
    filters,
  });
});

// Logs page
app.get('/logs', (req, res) => {
  const logs = getRecentLogs(100);
  
  res.render('logs', {
    title: 'System Logs - Matiks Monitor',
    logs,
  });
});

// API endpoints
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

app.get('/api/mentions', (req, res) => {
  const filters: MentionFilters = {
    platform: req.query.platform as MentionFilters['platform'],
    sentiment: req.query.sentiment as string | undefined,
    search: req.query.search as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit: parseInt(req.query.limit as string) || 50,
    offset: parseInt(req.query.offset as string) || 0,
  };
  res.json(getMentions(filters));
});

app.get('/api/reviews', (req, res) => {
  const filters = {
    platform: req.query.platform as 'playstore' | 'appstore' | undefined,
    rating: req.query.rating ? parseInt(req.query.rating as string) : undefined,
    sentiment: req.query.sentiment as string | undefined,
    search: req.query.search as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
    limit: parseInt(req.query.limit as string) || 50,
    offset: parseInt(req.query.offset as string) || 0,
  };
  res.json(getReviews(filters));
});

// System status / health
app.get('/api/status', (req, res) => {
  const platforms = ['reddit', 'playstore', 'appstore'];
  const rateLimits = platforms.reduce((acc, platform) => {
    acc[platform] = getRateLimitState(platform);
    return acc;
  }, {} as Record<string, ReturnType<typeof getRateLimitState>>);

  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    schedules: getScheduleInfo(),
    rateLimits,
    recentLogs: getRecentLogs(5),
  });
});

// CSV export
app.get('/api/export/mentions', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;
  const mentions = getMentions({ limit, offset });
  
  const csv = [
    ['Date', 'Platform', 'Author', 'Content', 'URL', 'Likes', 'Comments', 'Shares', 'Sentiment', 'Score'].join(','),
    ...mentions.map(m => [
      m.created_at,
      (m as any).platform_name || '',
      `"${(m.author || '').replace(/"/g, '""')}"`,
      `"${(m.content || '').replace(/"/g, '""')}"`,
      m.url || '',
      m.engagement_likes,
      m.engagement_comments,
      m.engagement_shares,
      m.sentiment_label || '',
      m.sentiment_score || '',
    ].join(','))
  ].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=mentions.csv');
  res.send(csv);
});

app.get('/api/export/reviews', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
  const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;
  const reviews = getReviews({ limit, offset });
  
  const csv = [
    ['Date', 'Store', 'Author', 'Rating', 'Title', 'Content', 'Version', 'Sentiment', 'Score'].join(','),
    ...reviews.map(r => [
      r.review_date,
      (r as any).platform_name || '',
      `"${(r.author || '').replace(/"/g, '""')}"`,
      r.rating,
      `"${(r.title || '').replace(/"/g, '""')}"`,
      `"${(r.content || '').replace(/"/g, '""')}"`,
      r.app_version || '',
      r.sentiment_label || '',
      r.sentiment_score || '',
    ].join(','))
  ].join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=reviews.csv');
  res.send(csv);
});

// Google Sheets export
app.get('/api/export/sheets', async (req, res) => {
  if (!config.google.enabled) {
    return res.status(400).json({ error: 'Google Sheets export is disabled. Configure credentials in .env' });
  }
  
  try {
    const service = new GoogleSheetsService();
    const type = req.query.type as string;
    
    if (type === 'mentions') {
      const mentions = getMentions();
      await service.exportMentions(mentions);
      res.json({ success: true, message: `Exported ${mentions.length} mentions to Google Sheet` });
    } else if (type === 'reviews') {
      const reviews = getReviews();
      await service.exportReviews(reviews);
      res.json({ success: true, message: `Exported ${reviews.length} reviews to Google Sheet` });
    } else {
      res.status(400).json({ error: 'Invalid type. Use ?type=mentions or ?type=reviews' });
    }
  } catch (error) {
    logger.error('Export failed', { error });
    res.status(500).json({ error: 'Export failed. Check server logs.' });
  }
});

export function startServer() {
  app.listen(config.port, () => {
    logger.info(`Dashboard running at http://localhost:${config.port}`);
  });
  
  return app;
}

export { app };
