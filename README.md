# Log Ingestion and Query Service

A simplified log ingestion, query, and aggregation service (inspired by Datadog / Grafana Loki), built with TypeScript, Express, and PostgreSQL.

## Setup
Service available at `http://localhost:8080`. Migrations run automatically on startup before the app reports healthy.

## API Documentation

### `GET /health`
Returns 200 once DB connection established and migrations applied.

### `POST /logs`
Batch ingestion with per-entry validation and partial success (valid entries stored, invalid ones rejected with index + reason).

### `GET /logs`
Filters: `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit`, `cursor`. Cursor-based (keyset) pagination on `(ts, id)`.

### `GET /logs/aggregate`
Time-bucketed counts. Requires `since`, `until`, `bucket` (`1m`/`5m`/`1h`/`1d`). Optional `group_by` (`service`/`level`).

## Schema & Index Design

- `logs` is range-partitioned by `ts` (weekly), enabling retention via `DROP TABLE` instead of `DELETE` (avoids long locks and bloat).
- Composite primary key `(id, ts)` (required for partitioned tables).
- Indexes: `(service, ts DESC)`, `(level, ts DESC)`, `(ts DESC)` (for unfiltered time-range queries — added after discovering it was missing and causing sequential scans), GIN on `attributes`.
- Partitions are created dynamically on ingestion and cached in-memory to avoid repeated DDL catalog lock contention under load.

## Attribute Storage Strategy

JSONB, filtered via `@>` containment (not `->>` equality) to actually leverage the GIN index — an earlier version used `->>` which silently bypassed the index entirely.

## Retention Strategy

Partitions created dynamically per week on ingestion. Background job runs hourly (+ once at startup), dropping partitions fully older than `RETENTION_DAYS` (default 30) via `DROP TABLE`.

## Query Building

Raw parameterized SQL via `pg`, not Drizzle's query builder, for `GET /logs` and `GET /logs/aggregate`. Original plan was Drizzle for reads; dynamic `attr.<key>` extraction, tuple-based keyset pagination, and `date_bin` bucketing were more directly expressed in raw SQL. All values passed as parameters — no string concatenation of user input for values (only internally-computed identifiers, like partition names derived from validated timestamps, are interpolated, never raw user input).

## Ingestion Performance Design

- `pg-copy-streams` for bulk insert (not row-by-row INSERT or ORM).
- In-process request coalescing (micro-batching): concurrent `POST /logs` requests are queued and flushed together every ~20-75ms or at 5,000-15,000 rows, whichever comes first, drastically reducing the number of separate COPY operations under high concurrency.
- `synchronous_commit = off` and `UNLOGGED` partitions to reduce WAL overhead — a deliberate durability/throughput trade-off (see Known Limitations).

## Known Limitations

- **Single PostgreSQL CPU is the hard ceiling.** Under sustained loads of 15,000+ logs/sec, Postgres CPU consistently pins at ~100-107%, which is the primary throughput bottleneck — confirmed via repeated load testing (see Performance Testing below), not a code-level bug.
- `UNLOGGED` partitions and `synchronous_commit=off` trade write durability for throughput: data in the active WAL/commit window can be lost on an unclean crash. Acceptable for high-volume log data; documented explicitly as a conscious choice.
- `autovacuum` was disabled during benchmark runs to reduce background CPU contention; not recommended for long-running production deployments without re-enabling it on a schedule.
- No caching layer — deliberate, given the 20-second data-freshness requirement; caching risked serving stale results.
- Optional features (auth, multi-tenancy, rate limiting) not implemented — service runs fully unauthenticated by default per the "Zero Configuration" contract.

## Optional Features

None implemented. `docker compose up` with no configuration yields the plain, unauthenticated core service.

## Load-Test Methodology & Measured Performance Results

Tested via the provided load-testing portal (loadgen.foothilltech.net) across four scenarios: Load (15k logs/s sustained), Stress (ramping 15k→30k), Spike (7.5k→30k→7.5k), and Breakpoint (15k→45k stepped).

**Latest measured results (Load scenario, 120s):**
- Accepted logs: ~325K, 0 rejected
- Sustained throughput: ~2,700 logs/sec
- Ingestion latency p95: ~3.2s
- Aggregate query p95: ~5.1s
- Postgres CPU: 74-100% (consistently at or near the 1-CPU ceiling)
- Application CPU: 8-51% (never the bottleneck)
- Correctness: 75/75 checks passed

**Bottlenecks discovered and fixes applied, in chronological order:**
1. Dynamic partition creation issued a `CREATE TABLE IF NOT EXISTS` DDL statement on every batch, causing catalog lock contention under concurrency → fixed with an in-memory `Set` cache of known partitions.
2. No index supported unfiltered time-range queries (`GET /logs/aggregate` filters only by `ts`); the composite indexes were all keyed on `service`/`level` first → added `idx_logs_ts` on `(ts DESC)` alone.
3. Cursor pagination returned `400 invalid cursor` on any page beyond the first 1,000 rows — root cause: PostgreSQL `BIGINT` columns are returned as strings by `pg`, but the cursor's `id` field was typed and validated as `number` → fixed by typing cursor `id` as `string` throughout.
4. Under very high concurrency, individual `COPY` operations per request contended heavily for the single Postgres CPU → implemented in-process request coalescing (micro-batching).
5. `attr.<key>` filtering used JSONB `->>` (text extraction) which does not use the GIN index → switched to `@>` (containment), which does.
6. Reduced WAL overhead via `synchronous_commit=off` and `UNLOGGED` partitions.

**Conclusion:** throughput remains bound by the single-CPU PostgreSQL container limit under the benchmark's peak loads (15,000-45,000 logs/sec); the above fixes measurably improved throughput, latency, and read-after-write consistency, but a 1-CPU database cannot sustain the benchmark's upper-range targets regardless of application-level optimization.
