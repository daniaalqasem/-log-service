import { pool } from '../db/client';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);
const PARTITION_NAME_PATTERN = /^logs_(\d{4})_(\d{2})_(\d{2})$/;

interface PartitionInfo {
  name: string;
  weekStart: Date;
}

async function listPartitions(): Promise<PartitionInfo[]> {
  const result = await pool.query(`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = 'logs'
  `);

  const partitions: PartitionInfo[] = [];

  for (const row of result.rows) {
    const match = row.partition_name.match(PARTITION_NAME_PATTERN);
    if (!match) continue;

    const [, year, month, day] = match;
    const weekStart = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );

    partitions.push({ name: row.partition_name, weekStart });
  }

  return partitions;
}

export async function runRetention(): Promise<string[]> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);

  const partitions = await listPartitions();
  const dropped: string[] = [];

  for (const partition of partitions) {
    const partitionEnd = new Date(partition.weekStart);
    partitionEnd.setUTCDate(partitionEnd.getUTCDate() + 7);

    if (partitionEnd.getTime() <= cutoff.getTime()) {
      await pool.query(`DROP TABLE IF EXISTS ${partition.name}`);
      dropped.push(partition.name);
    }
  }

  return dropped;
}

export function startRetentionScheduler(intervalMs: number = 60 * 60 * 1000): void {
  runRetention()
    .then((dropped) => {
      if (dropped.length > 0) {
        console.log('Retention: dropped partitions', dropped);
      }
    })
    .catch((error) => console.error('Retention job failed:', error));

  setInterval(() => {
    runRetention()
      .then((dropped) => {
        if (dropped.length > 0) {
          console.log('Retention: dropped partitions', dropped);
        }
      })
      .catch((error) => console.error('Retention job failed:', error));
  }, intervalMs);
}
