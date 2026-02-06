import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs/promises';
import { config } from '../config.js';
import { logger } from './logger.js';
import { Mention, Review } from '../db/queries.js';

export class GoogleSheetsService {
  private doc: GoogleSpreadsheet | null = null;
  private isInitialized = false;

  constructor() {}

  private async init() {
    if (this.isInitialized) return;
    
    if (!config.google.enabled) {
      throw new Error('Google Sheets export is disabled in config');
    }
    if (!config.google.spreadsheetId) {
      throw new Error('Google Sheets spreadsheet ID not configured. Set GOOGLE_SPREADSHEET_ID in .env');
    }

    try {
      // Load service account JSON
      const content = await fs.readFile(config.google.serviceAccountJson, 'utf-8');
      const creds = JSON.parse(content);

      const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.doc = new GoogleSpreadsheet(config.google.spreadsheetId, jwt);
      await this.doc.loadInfo();
      
      this.isInitialized = true;
      logger.info(`Google Sheets initialized: ${this.doc.title}`);
    } catch (error) {
      logger.error('Failed to initialize Google Sheets service', { error });
      throw error;
    }
  }

  private async getOrCreateSheet(title: string, headers: string[]): Promise<GoogleSpreadsheetWorksheet> {
    await this.init();
    if (!this.doc) {
      throw new Error('Google Spreadsheet not initialized');
    }

    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) {
      sheet = await this.doc.addSheet({ title, headerValues: headers });
    }
    return sheet;
  }

  private async replaceRows(sheet: GoogleSpreadsheetWorksheet, headers: string[], rows: Record<string, any>[]) {
    await sheet.clear();
    await sheet.setHeaderRow(headers);

    if (rows.length === 0) return;

    // Add rows in batches to avoid rate limits
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await sheet.addRows(batch);
    }
  }

  async exportMentions(mentions: Mention[]) {
    const headers = [
      'ID', 'Date', 'Platform', 'Author', 'Content', 'Sentiment', 'Score', 'URL', 'Likes', 'Comments'
    ];
    const sheet = await this.getOrCreateSheet('Mentions', headers);

    const rows = mentions.map(m => ({
      'ID': m.external_id,
      'Date': m.created_at,
      'Platform': (m as any).platform_name || m.platform_id || '',
      'Author': m.author || 'Unknown',
      'Content': m.content || '',
      'Sentiment': m.sentiment_label || '',
      'Score': m.sentiment_score || 0,
      'URL': m.url || '',
      'Likes': m.engagement_likes || 0,
      'Comments': m.engagement_comments || 0
    }));

    await this.replaceRows(sheet, headers, rows);
    logger.info(`Exported ${rows.length} mentions to Google Sheets (replace mode)`);
  }

  async exportReviews(reviews: Review[]) {
    const headers = [
      'ID', 'Date', 'Store', 'Author', 'Rating', 'Title', 'Content', 'Sentiment', 'Score', 'Version'
    ];
    const sheet = await this.getOrCreateSheet('Reviews', headers);

    const rows = reviews.map(r => ({
      'ID': r.external_id,
      'Date': r.review_date,
      'Store': (r as any).platform_name || r.platform_id || '',
      'Author': r.author || 'Anonymous',
      'Rating': r.rating || 0,
      'Title': r.title || '',
      'Content': r.content || '',
      'Sentiment': r.sentiment_label || '',
      'Score': r.sentiment_score || 0,
      'Version': r.app_version || ''
    }));

    await this.replaceRows(sheet, headers, rows);
    logger.info(`Exported ${rows.length} reviews to Google Sheets (replace mode)`);
  }
}
