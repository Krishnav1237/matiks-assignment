import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

// Ensure logs directory exists
if (!fs.existsSync(config.paths.logs)) {
  fs.mkdirSync(config.paths.logs, { recursive: true });
}

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      ),
    }),
    // File output
    new winston.transports.File({
      filename: path.join(config.paths.logs, 'scraper.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),
    // Error-only file
    new winston.transports.File({
      filename: path.join(config.paths.logs, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});
