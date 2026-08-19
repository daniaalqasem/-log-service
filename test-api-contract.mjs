#!/usr/bin/env node
/**
 * Contract test script for the Log Ingestion & Query Service.
 * Run with: node test-api-contract.mjs
 * Requires Node 18+ (built-in fetch). Assumes the service is up at BASE_URL.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function req(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text; // not JSON — kept raw for malformed-response checks
  }
  return { status: res.status, body };
}

// ---------- 1. Health check (with retry, since compose may still be starting) ----------
async function waitForHealth(maxAttempts = 20, delayMs = 1000) {
  section("1. GET /health");
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const { status } = await req("/health");
      if (status === 200) {
        ok("service reports healthy", true);
        return true;
      }
    } catch {
      // service not up yet, keep retrying
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  ok("service reports healthy within timeout", false, "gave up after retries");
  return false;
}

// ---------- 2. POST /logs ----------
async function testIngestion() {
  section("2. POST /logs");

  // 2a. Valid batch with one invalid entry mixed in
  const mixedBatch = {
    logs: [
      {
        timestamp: new Date().toISOString(),
        level: "error",
        service: "checkout",
        message: "payment declined",
        attributes: { user_id: "42", region: "eu-west", retries: 3 },
      },
      {
        timestamp: new Date().toISOString(),
        level: "critical", // invalid level
        service: "checkout",
        message: "bad level",
      },
      {
        timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min future — invalid
        level: "info",
        service: "auth",
        message: "too far future",
      },
      {
        timestamp: new Date().toISOString(),
        level: "info",
        service: "auth",
        message: "nested attrs",
        attributes: { nested: { a: 1 } }, // invalid: nested object
      },
    ],
  };
  const { status: s1, body: b1 } = await req("/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mixedBatch),
  });
  ok("mixed batch returns 200", s1 === 200, `got ${s1}`);
  ok("accepted count is 1", b1?.accepted === 1, `got ${JSON.stringify(b1)}`);
  ok(
    "rejected has 3 entries with index+reason",
    Array.isArray(b1?.rejected) &&
      b1.rejected.length === 3 &&
      b1.rejected.every((r) => typeof r.index === "number" && typeof r.reason === "string"),
    `got ${JSON.stringify(b1?.rejected)}`
  );

  // 2b. All-invalid batch -> 400
  const allInvalid = { logs: [{ timestamp: "not-a-date", level: "x", service: "", message: "" }] };
  const { status: s2 } = await req("/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(allInvalid),
  });
  ok("all-invalid batch returns 400", s2 === 400, `got ${s2}`);

  // 2c. Malformed JSON -> 400
  const { status: s3 } = await req("/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not valid json",
  });
  ok("malformed JSON returns 400", s3 === 400, `got ${s3}`);

  // 2d. Wrong top-level structure -> 400
  const { status: s4 } = await req("/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notLogs: [] }),
  });
  ok("wrong top-level shape returns 400", s4 === 400, `got ${s4}`);

  // 2e. Seed a larger, valid batch for query tests below
  const services = ["checkout", "auth", "search"];
  const levels = ["debug", "info", "warn", "error"];
  const seedLogs = Array.from({ length: 50 }, (_, i) => ({
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    level: levels[i % levels.length],
    service: services[i % services.length],
    message: `seed message ${i} declined`,
    attributes: { user_id: String(i % 5), region: "eu-west" },
  }));
  const { status: s5 } = await req("/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logs: seedLogs }),
  });
  ok("seed batch for query tests accepted", s5 === 200, `got ${s5}`);
}

// ---------- 3. GET /logs ----------
async function testQuery() {
  section("3. GET /logs");

  const { status: s1, body: b1 } = await req("/logs?service=checkout");
  ok("filter by service returns 200", s1 === 200, `got ${s1}`);
  ok(
    "all results match service filter",
    Array.isArray(b1?.logs) && b1.logs.every((l) => l.service === "checkout"),
    `got services: ${b1?.logs?.map((l) => l.service)}`
  );

  const { status: s2, body: b2 } = await req("/logs?level=error");
  ok(
    "filter by level returns only matching level",
    s2 === 200 && b2.logs.every((l) => l.level === "error"),
    `got ${s2}`
  );

  const { body: b3 } = await req("/logs?q=declined");
  ok(
    "q filter matches message substring case-insensitively",
    b3.logs.every((l) => l.message.toLowerCase().includes("declined")),
    `got ${JSON.stringify(b3.logs?.slice(0, 2))}`
  );

  const { body: b4 } = await req("/logs?attr.user_id=2");
  ok(
    "attr.<key> filter matches attribute value",
    b4.logs.every((l) => String(l.attributes?.user_id) === "2"),
    `got ${JSON.stringify(b4.logs?.slice(0, 2))}`
  );

  const { body: bNumericAttribute } = await req("/logs?attr.retries=3");
  ok(
    "numeric attribute filters use string comparison semantics",
    bNumericAttribute.logs.every((l) => String(l.attributes?.retries) === "3"),
    `got ${JSON.stringify(bNumericAttribute.logs?.slice(0, 2))}`
  );

  // Sort order: descending by timestamp
  const { body: b5 } = await req("/logs?limit=20");
  const timestamps = b5.logs.map((l) => new Date(l.timestamp).getTime());
  const sorted = [...timestamps].sort((a, b) => b - a);
  ok("results sorted descending by timestamp", JSON.stringify(timestamps) === JSON.stringify(sorted));

  // Pagination: small limit + cursor walk
  const { body: page1 } = await req("/logs?limit=5");
  ok("next_cursor present when more results exist", page1.next_cursor !== undefined);
  if (page1.next_cursor) {
    const { body: page2 } = await req(`/logs?limit=5&cursor=${encodeURIComponent(page1.next_cursor)}`);
    const ids1 = new Set(page1.logs.map((l) => l.id));
    const overlap = page2.logs.some((l) => ids1.has(l.id));
    ok("cursor pagination does not repeat entries", !overlap);
  }

  // Invalid params
  const { status: sInvalidLevel } = await req("/logs?level=bogus");
  ok("invalid level returns 400", sInvalidLevel === 400, `got ${sInvalidLevel}`);

  const { status: sBadCursor, body: bBadCursor } = await req("/logs?cursor=not-a-real-cursor");
  ok("malformed cursor returns 400", sBadCursor === 400, `got ${sBadCursor}, body ${JSON.stringify(bBadCursor)}`);

  const { status: sBadRange } = await req(
    "/logs?since=2026-08-01T00:00:00Z&until=2026-07-01T00:00:00Z"
  );
  ok("until earlier than since returns 400", sBadRange === 400, `got ${sBadRange}`);

  const { status: sBadLimit } = await req("/logs?limit=abc");
  ok("non-numeric limit returns 400", sBadLimit === 400, `got ${sBadLimit}`);

  const { status: sLimitRange } = await req("/logs?limit=5000");
  ok("limit above max returns 400", sLimitRange === 400, `got ${sLimitRange}`);
}

// ---------- 4. GET /logs/aggregate ----------
async function testAggregate() {
  section("4. GET /logs/aggregate");

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const until = new Date(Date.now() + 60 * 1000).toISOString();

  for (const bucket of ["1m", "5m", "1h", "1d"]) {
    const { status, body } = await req(
      `/logs/aggregate?since=${since}&until=${until}&bucket=${bucket}`
    );
    ok(`bucket=${bucket} returns 200 with buckets array`, status === 200 && Array.isArray(body?.buckets), `got ${status}`);
    if (Array.isArray(body?.buckets) && body.buckets.length) {
      ok(`bucket=${bucket} group is null without group_by`, body.buckets.every((b) => b.group === null));
    }
  }

  const { status: sGroup, body: bGroup } = await req(
    `/logs/aggregate?since=${since}&until=${until}&bucket=1h&group_by=service`
  );
  ok("group_by=service returns non-null group values", sGroup === 200 && bGroup.buckets.every((b) => b.group !== null));

  // Ascending order by bucket start
  const starts = bGroup.buckets.map((b) => new Date(b.start).getTime());
  const sortedStarts = [...starts].sort((a, b) => a - b);
  ok("buckets ordered ascending by start time", JSON.stringify(starts) === JSON.stringify(sortedStarts));

  // Missing required params -> 400
  const { status: sMissing } = await req(`/logs/aggregate?bucket=1h`);
  ok("missing since/until returns 400", sMissing === 400, `got ${sMissing}`);

  const { status: sBadBucket } = await req(`/logs/aggregate?since=${since}&until=${until}&bucket=3m`);
  ok("unsupported bucket size returns 400", sBadBucket === 400, `got ${sBadBucket}`);
}

async function main() {
  console.log(`Running contract tests against ${BASE_URL}\n`);
  const healthy = await waitForHealth();
  if (!healthy) {
    console.log("\nService never became healthy — skipping remaining tests.");
    process.exit(1);
  }
  await testIngestion();
  await testQuery();
  await testAggregate();

  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log("Failed checks:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
