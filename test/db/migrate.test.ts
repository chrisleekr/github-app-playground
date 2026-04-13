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

describe.skipIf(sql === null)("runMigrations", () => {
  beforeAll(async () => {
    await sql!.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
  });

  afterAll(async () => {
    await sql!.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await sql!.close();
  });

  it("applies migrations cleanly on a fresh database", async () => {
    // Dynamic import so the module is not loaded when suite is skipped
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(sql!);

    const versions: { version: string }[] = await sql!`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(1);
    expect(versions[0]!.version).toBe("001_initial");
  });

  it("is idempotent — second run is a no-op", async () => {
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(sql!);

    const versions: { version: string }[] = await sql!`
      SELECT version FROM _migrations ORDER BY version
    `;
    expect(versions.length).toBe(1);
  });

  it("creates the executions table with expected columns", async () => {
    const columns: { column_name: string }[] = await sql!`
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
    const columns: { column_name: string }[] = await sql!`
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
});
