/**
 * T050 — FR-014 operator aggregate queries integration test.
 *
 * Seeds a realistic mix of `executions` + `triage_results` rows through
 * the real migration pipeline, then runs each of the four queries from
 * `src/db/queries/dispatch-stats.ts` (mirroring
 * `contracts/dispatch-telemetry.md` §5) and asserts expected shapes +
 * aggregate values.
 *
 * Requires a running Postgres instance (`bun run dev:deps`). The suite
 * skips itself cleanly when the server is unreachable so contributors
 * without local infra can still run `bun test`.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

// Probe the database up-front — if Postgres is down we skip the suite
// entirely rather than failing every test with connection errors.
let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available — test should have been skipped");
  return sql;
}

// The queries module reads DATABASE_URL through `requireDb()` in
// `src/db/index.ts`, so we point that singleton at the same URL by
// setting the env var before the dynamic import below. The queries then
// open their own pool against the test DB.
process.env["DATABASE_URL"] = TEST_DATABASE_URL;

describe.skipIf(sql === null)("FR-014 aggregate queries — dispatch-stats.ts", () => {
  beforeAll(async () => {
    const db = requireSql();
    // Clean slate — drop everything and re-run migrations from scratch
    // so the test is independent of whatever state the local dev DB
    // happens to be in.
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(db);

    // Seed a deterministic mix of executions covering every
    // dispatch_target + dispatch_reason the queries care about. All
    // rows fall inside the default 30-day window.
    await db`
      INSERT INTO executions (
        delivery_id, repo_owner, repo_name, entity_number, entity_type,
        event_name, trigger_username, dispatch_mode, dispatch_target, dispatch_reason,
        triage_confidence, triage_cost_usd, triage_complexity, status, created_at
      ) VALUES
        ('d-1', 'o', 'r', 1, 'issue', 'issue_comment', 'u', 'inline',        'inline',        'static-default',         NULL, NULL, NULL,       'queued', NOW() - INTERVAL '6 hours'),
        ('d-2', 'o', 'r', 2, 'issue', 'issue_comment', 'u', 'shared-runner', 'shared-runner', 'triage',                 0.92, 0.0009, 'moderate', 'queued', NOW() - INTERVAL '6 hours'),
        ('d-3', 'o', 'r', 3, 'issue', 'issue_comment', 'u', 'shared-runner', 'shared-runner', 'default-fallback',       0.55, 0.0008, 'trivial',  'queued', NOW() - INTERVAL '6 hours'),
        ('d-4', 'o', 'r', 4, 'issue', 'issue_comment', 'u', 'isolated-job',  'isolated-job',  'triage-error-fallback',  NULL, NULL, NULL,       'queued', NOW() - INTERVAL '2 days'),
        ('d-5', 'o', 'r', 5, 'issue', 'issue_comment', 'u', 'daemon',        'daemon',        'label',                  NULL, NULL, NULL,       'queued', NOW() - INTERVAL '2 days'),
        ('d-6', 'o', 'r', 6, 'issue', 'issue_comment', 'u', 'daemon',        'daemon',        'keyword',                NULL, NULL, NULL,       'queued', NOW() - INTERVAL '2 days'),
        ('d-old', 'o','r', 99,'issue','issue_comment', 'u', 'inline',        'inline',        'static-default',         NULL, NULL, NULL,       'queued', NOW() - INTERVAL '60 days')
    `;

    // Seed triage_results — three rows inside the window (two with
    // confidence < 1.0 so sub_threshold_rate has signal) plus one
    // outside.
    await db`
      INSERT INTO triage_results (
        delivery_id, mode, confidence, complexity, rationale,
        cost_usd, latency_ms, provider, model, created_at
      ) VALUES
        ('d-2', 'shared-runner', 0.92, 'moderate', 'ok',    0.0009, 300, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '6 hours'),
        ('d-3', 'shared-runner', 0.55, 'trivial',  'weak',  0.0008, 250, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '6 hours'),
        ('d-7', 'shared-runner', 1.00, 'complex',  'solid', 0.0010, 400, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '3 days'),
        ('d-old-triage', 'shared-runner', 0.80, 'moderate', 'aged', 0.0007, 280, 'anthropic', 'haiku-3-5', NOW() - INTERVAL '60 days')
    `;
  });

  afterAll(async () => {
    const db = requireSql();
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await db.close();
  });

  it("eventsPerTarget — groups + orders by COUNT desc, excludes out-of-window rows", async () => {
    const { eventsPerTarget } = await import("../../src/db/queries/dispatch-stats");
    const rows = await eventsPerTarget(30);

    // 4 distinct targets in the window — inline=1 (the 60-day row is
    // excluded), shared-runner=2, isolated-job=1, daemon=2.
    const byTarget = new Map(rows.map((r) => [r.dispatch_target, r.events]));
    expect(byTarget.get("shared-runner")).toBe(2);
    expect(byTarget.get("daemon")).toBe(2);
    expect(byTarget.get("inline")).toBe(1);
    expect(byTarget.get("isolated-job")).toBe(1);

    // Ordered by events DESC — first row must have the largest count.
    const first = rows[0];
    expect(first).toBeDefined();
    expect(first?.events).toBeGreaterThanOrEqual(rows.at(-1)?.events ?? 0);
  });

  it("triageRate — counts triage/default-fallback/triage-error-fallback as triaged", async () => {
    const { triageRate } = await import("../../src/db/queries/dispatch-stats");
    const rows = await triageRate(30);

    // Collapse all days to a single totals pair. Rows outside the
    // window are excluded by the WHERE clause.
    const totalTriaged = rows.reduce((acc, r) => acc + r.triaged, 0);
    const totalAll = rows.reduce((acc, r) => acc + r.total, 0);

    // 3 triaged rows in-window (d-2 triage, d-3 default-fallback,
    // d-4 triage-error-fallback); 6 total in-window.
    expect(totalTriaged).toBe(3);
    expect(totalAll).toBe(6);

    // Every day row has numeric triage_pct ≤ 100.
    for (const r of rows) {
      expect(typeof r.triage_pct).toBe("number");
      expect(r.triage_pct).toBeGreaterThanOrEqual(0);
      expect(r.triage_pct).toBeLessThanOrEqual(100);
    }
  });

  it("avgConfidenceAndFallback — averages over triage_results only, in-window", async () => {
    const { avgConfidenceAndFallback } = await import("../../src/db/queries/dispatch-stats");
    const row = await avgConfidenceAndFallback(30);

    expect(row.avg_confidence).not.toBeNull();
    // (0.92 + 0.55 + 1.00) / 3 ≈ 0.823
    expect(row.avg_confidence).toBeGreaterThan(0.8);
    expect(row.avg_confidence).toBeLessThan(0.85);

    expect(row.sub_threshold_rate).not.toBeNull();
    // 2 of 3 in-window rows have confidence < 1.0
    expect(row.sub_threshold_rate).toBeCloseTo(2 / 3, 5);
  });

  it("triageSpend — sums cost_usd across in-window triage_results", async () => {
    const { triageSpend } = await import("../../src/db/queries/dispatch-stats");
    const row = await triageSpend(30);

    expect(row.total_triage_spend_usd).not.toBeNull();
    // 0.0009 + 0.0008 + 0.0010 = 0.0027 (the 60-day row is excluded).
    expect(row.total_triage_spend_usd).toBeCloseTo(0.0027, 6);
  });

  it("queries honour the `days` parameter — shrinking the window drops rows", async () => {
    const { eventsPerTarget, triageSpend } = await import("../../src/db/queries/dispatch-stats");

    // Window of 1 day excludes the 2-day-old and 3-day-old rows.
    const rows = await eventsPerTarget(1);
    const byTarget = new Map(rows.map((r) => [r.dispatch_target, r.events]));
    expect(byTarget.get("shared-runner")).toBe(2); // d-2 + d-3 both 1-day
    expect(byTarget.get("daemon")).toBeUndefined(); // d-5 + d-6 are 2-day
    expect(byTarget.get("isolated-job")).toBeUndefined(); // d-4 is 2-day

    const spend = await triageSpend(1);
    // Only the two 1-day-old triage rows (0.0009 + 0.0008).
    expect(spend.total_triage_spend_usd).toBeCloseTo(0.0017, 6);
  });
});
