import { pgTable, bigserial, timestamp, text, smallint, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';



export const logs = pgTable(
  'logs',
  {
    id: bigserial('id', { mode: 'number' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    level: smallint('level').notNull(),
    service: text('service').notNull(),
    message: text('message').notNull(),
    attributes: jsonb('attributes').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.ts] }),
 
    // فلترة بـ service + ترتيب بالوقت (GET /logs?service=...)
    serviceTsIdx: index('idx_logs_service_ts').on(table.service, table.ts.desc()),
 
    // فلترة بـ level + ترتيب بالوقت (GET /logs?level=...)
    levelTsIdx: index('idx_logs_level_ts').on(table.level, table.ts.desc()),
 
    // فلترة على أي attribute حر (GET /logs?attr.key=value)
    // GIN index مصمم خصيصاً للبحث جوا بنية JSONB
    attributesIdx: index('idx_logs_attributes').using('gin', table.attributes),
  })
);



export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
 
export function levelToInt(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}
 
export function intToLevel(value: number): LogLevel {
  const level = LOG_LEVELS[value];
  if (!level) {
    throw new Error(`Unknown log level value: ${value}`);
  }
  return level;
}
 
