import { pool } from '../db/client';
import { intToLevel, levelToInt, LOG_LEVELS } from '../db/schema';
import { encodeCursor, decodeCursor } from '../utils/cursor';

export interface QueryLogsParams {
  service?: string;
  level?: string;
  since?: string;
  until?: string;
  attrFilters: Record<string, string>;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface QueryLogsError {
  error: string;
}

export interface QueryLogsResult {
  logs: Array<{
    id: string;
    timestamp: string;
    level: string;
    service: string;
    message: string;
    attributes: Record<string, unknown>;
  }>;
  next_cursor: string | null;
}

export function validateQueryParams(
  params: QueryLogsParams
): QueryLogsError | null {
  if (params.level !== undefined && !LOG_LEVELS.includes(params.level as any)) {
    return { error: `invalid level: '${params.level}'` };
  }

  if (params.since !== undefined && isNaN(Date.parse(params.since))) {
    return { error: `invalid since timestamp: '${params.since}'` };
  }

  if (params.until !== undefined && isNaN(Date.parse(params.until))) {
    return { error: `invalid until timestamp: '${params.until}'` };
  }

  if (
    params.since !== undefined &&
    params.until !== undefined &&
    new Date(params.until).getTime() < new Date(params.since).getTime()
  ) {
    return { error: 'until must not be earlier than since' };
  }

  if (params.limit !== undefined) {
    if (isNaN(params.limit) || params.limit < 1 || params.limit > 1000) {
      return { error: 'limit must be a number between 1 and 1000' };
    }
  }

  if (params.cursor !== undefined && decodeCursor(params.cursor) === null) {
    return { error: 'invalid cursor' };
  }

  return null;
}

export async function queryLogs(
  params: QueryLogsParams
): Promise<QueryLogsResult> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.service !== undefined) {
    conditions.push(`service = $${paramIndex++}`);
    values.push(params.service);
  }

  if (params.level !== undefined) {
    conditions.push(`level = $${paramIndex++}`);
    values.push(levelToInt(params.level as any));
  }

  if (params.since !== undefined) {
    conditions.push(`ts >= $${paramIndex++}`);
    values.push(params.since);
  }

  if (params.until !== undefined) {
    conditions.push(`ts < $${paramIndex++}`);
    values.push(params.until);
  }

  if (params.q !== undefined) {
    conditions.push(`message ILIKE $${paramIndex++}`);
    values.push(`%${params.q}%`);
  }

  for (const [key, val] of Object.entries(params.attrFilters)) {
    conditions.push(`attributes ->> $${paramIndex++} = $${paramIndex++}`);
    values.push(key, val);
  }

  if (params.cursor !== undefined) {
    const decoded = decodeCursor(params.cursor)!;
    conditions.push(`(ts, id) < ($${paramIndex++}, $${paramIndex++})`);
    values.push(decoded.ts, decoded.id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 100;

  const sql = `
    SELECT id, ts, level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY ts DESC, id DESC
    LIMIT $${paramIndex}
  `;
  values.push(limit + 1);

  const result = await pool.query(sql, values);
  const rows = result.rows;

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const logs = pageRows.map((row) => ({
    id: String(row.id),
    timestamp: new Date(row.ts).toISOString(),
    level: intToLevel(row.level),
    service: row.service,
    message: row.message,
    attributes: row.attributes,
  }));

  let next_cursor: string | null = null;
  if (hasMore) {
    const lastRow = pageRows[pageRows.length - 1];
    next_cursor = encodeCursor({
      ts: new Date(lastRow.ts).toISOString(),
      id: lastRow.id,
    });
  }

  return { logs, next_cursor };
}
