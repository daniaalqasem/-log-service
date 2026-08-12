import { pool } from '../db/client';
import { LOG_LEVELS } from '../db/schema';

const BUCKET_INTERVALS: Record<string, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
};

export interface AggregateParams {
  service?: string;
  level?: string;
  attrFilters: Record<string, string>;
  q?: string;
  since?: string;
  until?: string;
  bucket?: string;
  group_by?: string;
}

export interface AggregateError {
  error: string;
}

export interface AggregateBucket {
  start: string;
  group: string | null;
  count: number;
}

export function validateAggregateParams(
  params: AggregateParams
): AggregateError | null {
  if (params.since === undefined) {
    return { error: 'since is required' };
  }
  if (params.until === undefined) {
    return { error: 'until is required' };
  }
  if (isNaN(Date.parse(params.since))) {
    return { error: `invalid since timestamp: '${params.since}'` };
  }
  if (isNaN(Date.parse(params.until))) {
    return { error: `invalid until timestamp: '${params.until}'` };
  }
  if (new Date(params.until).getTime() < new Date(params.since).getTime()) {
    return { error: 'until must not be earlier than since' };
  }

  if (params.bucket === undefined) {
    return { error: 'bucket is required' };
  }
  if (!(params.bucket in BUCKET_INTERVALS)) {
    return { error: `invalid bucket: '${params.bucket}'` };
  }

  if (params.level !== undefined && !LOG_LEVELS.includes(params.level as any)) {
    return { error: `invalid level: '${params.level}'` };
  }

  if (
    params.group_by !== undefined &&
    params.group_by !== 'service' &&
    params.group_by !== 'level'
  ) {
    return { error: `invalid group_by: '${params.group_by}'` };
  }

  return null;
}

export async function aggregateLogs(
  params: AggregateParams
): Promise<AggregateBucket[]> {
  const conditions: string[] = ['ts >= $1', 'ts < $2'];
  const values: unknown[] = [params.since, params.until];
  let paramIndex = 3;

  if (params.service !== undefined) {
    conditions.push(`service = $${paramIndex++}`);
    values.push(params.service);
  }

  if (params.level !== undefined) {
    const levelInt = LOG_LEVELS.indexOf(params.level as any);
    conditions.push(`level = $${paramIndex++}`);
    values.push(levelInt);
  }

  if (params.q !== undefined) {
    conditions.push(`message ILIKE $${paramIndex++}`);
    values.push(`%${params.q}%`);
  }

  for (const [key, val] of Object.entries(params.attrFilters)) {
    conditions.push(`attributes ->> $${paramIndex++} = $${paramIndex++}`);
    values.push(key, val);
  }

  const interval = BUCKET_INTERVALS[params.bucket!];
  const groupColumn =
    params.group_by === 'service' ? 'service' : params.group_by === 'level' ? 'level' : null;

  const selectGroup = groupColumn ? `${groupColumn} AS grp` : 'NULL AS grp';
  const groupByClause = groupColumn ? 'bucket_start, grp' : 'bucket_start';

  const sql = `
    SELECT
      date_bin('${interval}', ts, TIMESTAMP '2000-01-01') AS bucket_start,
      ${selectGroup},
      COUNT(*) AS cnt
    FROM logs
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${groupByClause}
    ORDER BY bucket_start ASC
  `;

  const result = await pool.query(sql, values);

  return result.rows.map((row) => ({
    start: new Date(row.bucket_start).toISOString(),
    group:
      groupColumn === 'level'
        ? row.grp !== null
          ? LOG_LEVELS[row.grp]
          : null
        : row.grp,
    count: Number(row.cnt),
  }));
}
