import { logEntrySchema } from '../validation/logEntry.schema';
import { levelToInt } from '../db/schema';
import { pool } from '../db/client';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

interface RejectedEntry {
  index: number;
  reason: string;
}

interface ValidatedEntry {
  ts: string;
  level: number;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
}

interface ValidationResult {
  accepted: ValidatedEntry[];
  rejected: RejectedEntry[];
}

export function validateBatch(rawLogs: unknown[]): ValidationResult {
  const accepted: ValidatedEntry[] = [];
  const rejected: RejectedEntry[] = [];

  rawLogs.forEach((rawEntry, index) => {
    const result = logEntrySchema.safeParse(rawEntry);

    if (!result.success) {
      const firstIssue = result.error.issues[0];
      rejected.push({ index, reason: firstIssue.message });
      return;
    }

    accepted.push({
      ts: result.data.timestamp,
      level: levelToInt(result.data.level),
      service: result.data.service,
      message: result.data.message,
      attributes: result.data.attributes ?? {},
    });
  });

  return { accepted, rejected };
}

function getWeekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

function formatPartitionName(weekStart: Date): string {
  const year = weekStart.getUTCFullYear();
  const month = String(weekStart.getUTCMonth() + 1).padStart(2, '0');
  const day = String(weekStart.getUTCDate()).padStart(2, '0');
  return `logs_${year}_${month}_${day}`;
}

const knownPartitions = new Set<string>();

async function ensurePartitionsExist(entries: ValidatedEntry[]): Promise<void> {
  const weekStarts = new Set<string>();

  for (const entry of entries) {
    const weekStart = getWeekStart(new Date(entry.ts));
    weekStarts.add(weekStart.toISOString());
  }

  for (const weekStartIso of weekStarts) {
    const weekStart = new Date(weekStartIso);
    const partitionName = formatPartitionName(weekStart);

    if (knownPartitions.has(partitionName)) continue;

    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    await pool.query(
      `CREATE UNLOGGED TABLE IF NOT EXISTS ${partitionName}
       PARTITION OF logs
       FOR VALUES FROM ('${weekStart.toISOString()}') TO ('${weekEnd.toISOString()}')`
    );

    knownPartitions.add(partitionName);
  }
}

function escapeCopyValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

function entryToCopyLine(entry: ValidatedEntry): string {
  const attributesJson = JSON.stringify(entry.attributes);
  const fields = [entry.ts, String(entry.level), entry.service, entry.message, attributesJson]
    .map((field) => escapeCopyValue(field));
  return fields.join('\t') + '\n';
}

async function copyEntriesToDb(entries: ValidatedEntry[]): Promise<void> {
  await ensurePartitionsExist(entries);

  const client = await pool.connect();
  try {
    const copyStream = client.query(
      copyFrom(`COPY logs (ts, level, service, message, attributes) FROM STDIN WITH (FORMAT text)`)
    );
    const dataLines = entries.map(entryToCopyLine).join('');
    const sourceStream = Readable.from([dataLines]);
    await pipeline(sourceStream, copyStream);
  } finally {
    client.release();
  }
}

interface FlushWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

let pendingQueue: ValidatedEntry[] = [];
let pendingWaiters: FlushWaiter[] = [];
let flushTimer: NodeJS.Timeout | null = null;

const FLUSH_INTERVAL_MS = 20;
const MAX_QUEUE_SIZE = 5000;

async function flushQueue(): Promise<void> {
  if (pendingQueue.length === 0) return;

  const batch = pendingQueue;
  const waiters = pendingWaiters;
  pendingQueue = [];
  pendingWaiters = [];

  try {
    await copyEntriesToDb(batch);
    waiters.forEach((w) => w.resolve());
  } catch (error) {
    waiters.forEach((w) => w.reject(error));
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue();
  }, FLUSH_INTERVAL_MS);
}

export function insertBatch(entries: ValidatedEntry[]): Promise<void> {
  if (entries.length === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    pendingQueue.push(...entries);
    pendingWaiters.push({ resolve, reject });

    if (pendingQueue.length >= MAX_QUEUE_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushQueue();
    } else {
      scheduleFlush();
    }
  });
}
