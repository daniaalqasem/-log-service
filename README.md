# Log Ingestion and Query Service

A simplified log ingestion, query, and aggregation service (inspired by Datadog / Grafana Loki), built with TypeScript, Express, and PostgreSQL.

## Setup
The service will be available at `http://localhost:8080`. Migrations run automatically on container startup before the app reports healthy.

## API Documentation

### `GET /health`
Returns `200` once the database connection is established and migrations are applied.

### `POST /logs`
Ingests a batch of log entries. Accepts partial success: valid entries are stored, invalid entries are rejected with their index and reason.

### `GET /logs`
Query logs with optional, freely combinable filters: `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit`, `cursor`. Uses cursor (keyset) pagination.

### `GET /logs/aggregate`
Time-bucketed counts. Requires `since`, `until`, `bucket` (`1m`, `5m`, `1h`, `1d`). Optional `group_by` (`service` or `level`).

## Schema & Index Design

- `logs` table is range-partitioned by `ts` (weekly partitions), enabling retention via `DROP TABLE` instead of `DELETE`.
- Composite primary key `(id, ts)` — required by PostgreSQL for partitioned tables.
- Indexes: `(service, ts DESC)`, `(level, ts DESC)`, GIN index on `attributes`.
- `logs_default` partition acts as a safety net.

## Attribute Storage Strategy

Attributes stored as JSONB. Single-row insert regardless of shape; GIN-indexed for `attr.<key>` filtering.

## Retention Strategy

Partitions created dynamically (weekly) on ingestion. Background job runs hourly, dropping partitions older than `RETENTION_DAYS` (default 30) via `DROP TABLE`.

## Query Building

`GET /logs` and `GET /logs/aggregate` use parameterized raw SQL via `pg`, not Drizzle's query builder. Original plan was Drizzle for reads; during implementation, dynamic `attr.<key>` extraction, tuple-based keyset pagination, and `date_bin` bucketing were more directly expressed in raw SQL. All values passed as parameters.

## Known Limitations

- No caching layer (deliberate, given 20-second freshness requirement).
- Optional features (auth, rate limiting) not implemented; service runs unauthenticated by default.

## Performance Testing

_To be filled in after load testing._
