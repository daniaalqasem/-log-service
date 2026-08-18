# Log Ingestion and Query Service

A high-throughput log ingestion, search, and aggregation service inspired by Datadog and Grafana Loki. It is implemented with TypeScript, Express, and PostgreSQL.

## Features

- Batch log ingestion with per-record validation and partial-success responses.
- Filtered log search with keyset (cursor) pagination.
- Time-bucket aggregation with optional grouping by service or log level.
- Dynamic JSON attributes and `attr.<key>` filters.
- Weekly PostgreSQL partitions with automated retention cleanup.
- Automatic database migrations and a readiness-aware health check.
- Docker Compose setup with no configuration required for the core service.

## Quick start

### Prerequisites

- Docker Desktop (or Docker Engine) with Docker Compose.

### Run locally

```bash
docker compose up --build
```

The API is available at `http://localhost:8080`.

Check that startup and migrations completed:

```bash
curl http://localhost:8080/health
```

Expected response:

```json
{"status":"ok"}
```

Stop the stack:

```bash
docker compose down
```

To also remove the local database volume:

```bash
docker compose down -v
```

## API

### `GET /health`

Returns `200` only after migrations complete and PostgreSQL is reachable.

```json
{"status":"ok"}
```

While the service is starting, it returns `503` with `{"status":"starting"}`.

### `POST /logs`

Accepts a JSON object containing a `logs` array. Valid entries are stored; invalid entries are reported without preventing valid entries in the same batch from being accepted.

```bash
curl -X POST http://localhost:8080/logs \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      {
        "timestamp": "2026-08-18T10:00:00Z",
        "level": "info",
        "service": "api",
        "message": "request completed",
        "attributes": {"region": "eu", "request_id": "req-123"}
      }
    ]
  }'
```

Successful response:

```json
{
  "accepted": 1,
  "rejected": []
}
```

An invalid request body, or a batch containing no valid entries, returns `400`.

### `GET /logs`

Returns logs ordered newest first. Supported query parameters:

| Parameter | Description |
| --- | --- |
| `service` | Exact service name |
| `level` | Exact level (`debug`, `info`, `warn`, `error`) |
| `since`, `until` | ISO-8601 time range |
| `q` | Case-insensitive message text search |
| `attr.<key>` | Exact dynamic attribute filter, for example `attr.region=eu` |
| `limit` | Page size |
| `cursor` | Cursor returned by the preceding page |

Example:

```bash
curl "http://localhost:8080/logs?service=api&since=2026-08-18T00:00:00Z&limit=100"
```

The response contains `logs` and `next_cursor`. Pass `next_cursor` as `cursor` to fetch the next page.

### `GET /logs/aggregate`

Returns time-bucketed counts. Required parameters are `since`, `until`, and `bucket`.

- Valid `bucket` values: `1m`, `5m`, `1h`, `1d`
- Optional `group_by`: `service` or `level`
- Also supports `service`, `level`, `q`, and `attr.<key>` filters.

```bash
curl "http://localhost:8080/logs/aggregate?since=2026-08-18T00:00:00Z&until=2026-08-19T00:00:00Z&bucket=1h&group_by=service"
```

Example response:

```json
{
  "buckets": [
    {
      "bucket": "2026-08-18T10:00:00.000Z",
      "service": "api",
      "count": 42
    }
  ]
}
```

## Architecture and data design

### Storage model

- PostgreSQL stores logs in a range-partitioned table by timestamp, using weekly partitions.
- The primary key is `(id, ts)`, which is required for this partitioning design.
- Partitions are created on demand during ingestion and tracked in memory to avoid repeated DDL/catalog work under concurrent load.

### Indexes

- `(service, ts DESC)` supports service-scoped recent-log queries.
- `(level, ts DESC)` supports level-scoped recent-log queries.
- `(ts DESC)` supports unfiltered time-range reads and aggregation scans.
- A GIN index on `attributes` supports JSONB containment filters.

### Attribute strategy

Dynamic attributes are stored as JSONB. Attribute filters use JSONB containment rather than text extraction, so the GIN index remains usable.

### Retention

The retention job runs at startup and then hourly. It removes partitions wholly older than `RETENTION_DAYS`; the default is 30 days. Dropping an old partition is faster and avoids the table bloat caused by mass `DELETE` operations.

## Performance design

- `pg-copy-streams` performs bulk inserts instead of one SQL insert per log row.
- Concurrent ingestion requests are coalesced into short micro-batches before copying them to PostgreSQL.
- Cursor pagination uses the stable `(ts, id)` keyset, avoiding the cost and inconsistency of offset pagination at high offsets.
- Query values use parameterized SQL. Only internally generated, validated partition identifiers are constructed dynamically.

## Local benchmark result

The following result was measured locally with the supplied Foothill benchmark CLI using Docker Desktop configured with 6 CPUs and 8 GiB RAM. The benchmark constrains the application to 0.5 CPU / 256 MiB and PostgreSQL to 1 CPU / 1024 MiB.

| Category | Result |
| --- | ---: |
| Correctness | 15.0 / 15 (15/15 checks) |
| Performance | 48.2 / 50 |
| Queries | 1.5 / 15 |
| Reliability | 20.0 / 20 (4/4 scenarios) |
| **Total** | **84.7 / 100** |
| Ingestion throughput | 14,999 logs/s |
| Ingestion errors | 0.0% |
| Ingestion p95 | 262 ms |
| Aggregate p95 | 583 ms |
| Query consistency | 1/4 |

Run the same full local benchmark from the repository root:

```bash
npx --yes "github:Ahmad-Abbas-Foothill/logs-benchmark-cli#992d9c8" --compose ./docker-compose.yml --full --seed 6122026 --generator-cpus 2
```

The performance and query scores are environment-sensitive, so a later run or the official platform may report different values.

## Known limitations and trade-offs

- The service is optimized for high ingestion throughput under the provided benchmark resource limits. Aggregate queries are the main remaining performance opportunity; the most recent aggregate p95 was 583 ms.
- PostgreSQL has a 1-CPU benchmark limit, so it becomes the throughput ceiling under the highest offered rates.
- The current benchmark configuration uses `UNLOGGED` partitions and `synchronous_commit=off` to reduce write-ahead-log overhead. This improves throughput but data not yet safely persisted can be lost after an unclean PostgreSQL restart. A production deployment requiring strict durability should use logged tables and synchronous commits instead.
- Optional features such as authentication, tenant isolation, and rate limiting are intentionally not enabled. The default Docker Compose setup is a zero-configuration core service.

## CI

GitHub Actions builds the project, starts the Compose stack, waits for `/health`, and runs API smoke tests for ingestion, querying, and aggregation.

## Project scripts

```bash
npm run build   # TypeScript compilation
npm run dev     # Run the development server with tsx
npm start       # Run the compiled server
```
