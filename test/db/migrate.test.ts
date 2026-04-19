/**
 * Integration tests for the database migration runner.
 *
 * Requires a running Postgres instance (bun run dev:deps).
 * Uses a dedicated test database to avoid colliding with development data.
 * Skips the entire suite when Postgres is not available.
 *
 * Dynamic imports prevent coverage instrumentation of src/db/migrate.ts
 * when the suite is skipped — avoids failing the 90% per-file threshold.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

// Attempt to connect — skip all tests if Postgres is unreachable.
let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireDb(): SQL {
  if (sql === null) throw new Error("Database not available — test should have been skipped");
  return sql;
}

describe.skipIf(sql === null)("runMigrations", () => {
  beforeAll(async () => {
    await requireDb().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
  });

  afterAll(async () => {
    await requireDb().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await requireDb().close();
  });

  it("applies migrations cleanly on a fresh database", async () => {
    // Dynamic import so the module is not loaded when suite is skipped
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const versions: { version: string }[] = await requireDb()`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(4);
    expect(versions[0]?.version).toBe("001_initial");
    expect(versions[1]?.version).toBe("002_repo_knowledge");
    expect(versions[2]?.version).toBe("003_dispatch_decisions");
    expect(versions[3]?.version).toBe("004_collapse_dispatch_to_daemon");
  });

  it("is idempotent — second run is a no-op", async () => {
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireDb());

    const versions: { version: string }[] = await requireDb()`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(4);
  });

  it("creates the executions table with expected columns", async () => {
    const columns: { column_name: string }[] = await requireDb()`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'executions'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("delivery_id");
    expect(names).toContain("repo_owner");
    expect(names).toContain("dispatch_mode");
    expect(names).toContain("status");
    expect(names).toContain("cost_usd");
    expect(names).toContain("triage_result");
    expect(names).toContain("daemon_id");
  });

  it("creates the daemons table with expected columns", async () => {
    const columns: { column_name: string }[] = await requireDb()`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'daemons'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("hostname");
    expect(names).toContain("platform");
    expect(names).toContain("capabilities");
    expect(names).toContain("status");
  });

  it("extends the executions table with dispatch-decision columns (003)", async () => {
    const columns: { column_name: string; column_default: string | null }[] = await requireDb()`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'executions'
      ORDER BY ordinal_position
    `;
    const byName = new Map(columns.map((c) => [c.column_name, c]));

    expect(byName.has("dispatch_target")).toBe(true);
    expect(byName.has("dispatch_reason")).toBe(true);
    expect(byName.has("triage_confidence")).toBe(true);
    expect(byName.has("triage_cost_usd")).toBe(true);
    // After migration 004 the executions row stores no per-row complexity.
    expect(byName.has("triage_complexity")).toBe(false);
  });

  it("creates the triage_results table with the expected schema (003)", async () => {
    const columns: { column_name: string; is_nullable: string }[] = await requireDb()`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'triage_results'
      ORDER BY ordinal_position
    `;
    const names = columns.map((c) => c.column_name);

    expect(names).toContain("id");
    expect(names).toContain("delivery_id");
    expect(names).toContain("mode");
    expect(names).toContain("confidence");
    // Post-collapse: complexity column is dropped, replaced by binary `heavy`.
    expect(names).not.toContain("complexity");
    expect(names).toContain("heavy");
    expect(names).toContain("rationale");
    expect(names).toContain("cost_usd");
    expect(names).toContain("latency_ms");
    expect(names).toContain("provider");
    expect(names).toContain("model");
    expect(names).toContain("created_at");

    // Everything except the allowed-nullable columns should be NOT NULL.
    const notNull = columns.filter((c) => c.is_nullable === "NO").map((c) => c.column_name);
    expect(notNull).toContain("delivery_id");
    expect(notNull).toContain("mode");
    expect(notNull).toContain("confidence");
    expect(notNull).toContain("rationale");
  });
});
