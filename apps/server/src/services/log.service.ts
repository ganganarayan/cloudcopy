import pino, { type Logger } from 'pino';
import type { Db } from '../db/client.js';
import { logs } from '../db/schema.js';

export type LogCategory = 'engine' | 'api' | 'provider' | 'auth' | 'retry' | 'system' | 'scanner' | 'planner';

interface LogRow {
  ts: Date;
  level: string;
  category: LogCategory;
  jobId?: string | null;
  jobFileId?: string | null;
  message: string;
  data?: Record<string, unknown> | null;
}

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 100;

/**
 * Structured logging: every entry goes to pino (stdout → Railway logs) AND is
 * batched into the logs table (flush every 2s or 100 rows, whichever first).
 */
export class LogService {
  readonly pino: Logger;
  private buffer: LogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly db: Db,
    opts?: { level?: string },
  ) {
    this.pino = pino({ level: opts?.level ?? 'info' });
  }

  log(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
    ids?: { jobId?: string; jobFileId?: string },
  ): void {
    this.pino[level]({ category, ...ids, ...data }, message);
    if (this.closed) return;
    this.buffer.push({
      ts: new Date(),
      level,
      category,
      jobId: ids?.jobId ?? null,
      jobFileId: ids?.jobFileId ?? null,
      message,
      data: data ?? null,
    });
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref();
    }
  }

  info(category: LogCategory, message: string, data?: Record<string, unknown>, ids?: { jobId?: string; jobFileId?: string }) {
    this.log('info', category, message, data, ids);
  }
  warn(category: LogCategory, message: string, data?: Record<string, unknown>, ids?: { jobId?: string; jobFileId?: string }) {
    this.log('warn', category, message, data, ids);
  }
  error(category: LogCategory, message: string, data?: Record<string, unknown>, ids?: { jobId?: string; jobFileId?: string }) {
    this.log('error', category, message, data, ids);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.db.insert(logs).values(rows);
    } catch (err) {
      // DB logging must never take the app down; stdout still has everything.
      this.pino.error({ err, dropped: rows.length }, 'failed to flush log batch to database');
    }
  }

  /** Flush remaining rows and stop accepting new ones (graceful shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
