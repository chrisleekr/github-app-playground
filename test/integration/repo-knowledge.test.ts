/**
 * Regression test for the Bun.sql array-binding bug surfaced by the
 * 2026-04-16 daemon-mode smoke test: passing a JS string[] directly to
 * `WHERE id = ANY(${ids})` was encoded as a comma-joined string,
 * causing PostgresError "malformed array literal" the moment
 * `repo_memory` had any rows.
 *
 * The fix switches both queries to Bun's IN-list expansion form,
 * `WHERE id IN ${db(ids)}`, which expands the UUID array as
 * parameterised IN-list values instead of binding it through `ANY(...)`.
 *
 * This suite exercises the two affected functions against a real
 * Postgres instance:
 *   - getRepoMemory      -> UPDATE … WHERE id IN (…)
 *   - deleteRepoMemories -> DELETE … WHERE id IN (…)
 *
 * This suite is DESTRUCTIVE: `beforeAll` drops and re-creates the
 * `repo_memory`, `triage_results`, `executions`, and `daemons` tables.
 * To avoid wiping a developer's local database by accident, the suite
 * is opt-in — it only runs when `TEST_DATABASE_URL` is explicitly set.
 * It skips cleanly otherwise so `bun test` without infra is safe.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

let sql: SQL | null = null;
if (TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL.length > 0) {
  try {
    const conn = new SQL(TEST_DATABASE_URL);
    await conn`SELECT 1 AS ok`;
    sql = conn;
  } catch {
    sql = null;
  }
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available — test should have been skipped");
  return sql;
}

const TEST_OWNER = "repo-knowledge-test-owner";
const TEST_REPO = "repo-knowledge-test-repo";

describe.skipIf(sql === null)("repo-knowledge ANY() array binding regression", () => {
  beforeAll(async () => {
    const db = requireSql();
    await db.unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(db);
  });

  afterAll(async () => {
    const db = sql;
    if (db === null) return;
    try {
      await db`DELETE FROM repo_memory WHERE repo_owner = ${TEST_OWNER}`;
    } finally {
      await db.close();
    }
  });

  it("getRepoMemory updates last_read_at without ANY() binding error when rows exist", async () => {
    const db = requireSql();

    // Seed three unpinned rows so getRepoMemory's ORDER BY ... LIMIT 5
    // path is exercised and the UPDATE … WHERE id IN (…) branch actually fires.
    await db`
      INSERT INTO repo_memory (repo_owner, repo_name, category, content, pinned, updated_at)
      VALUES
        (${TEST_OWNER}, ${TEST_REPO}, 'gotchas', 'note A', false, NOW() - INTERVAL '1 hour'),
        (${TEST_OWNER}, ${TEST_REPO}, 'setup',   'note B', false, NOW() - INTERVAL '2 hours'),
        (${TEST_OWNER}, ${TEST_REPO}, 'env',     'note C', false, NOW() - INTERVAL '3 hours')
    `;

    const { getRepoMemory } = await import("../../src/orchestrator/repo-knowledge");

    // Before the fix this threw PostgresError 22P02 "malformed array literal"
    // because Bun.sql encoded the JS string[] as a comma-joined string.
    // The IN ${db(ids)} expansion exercises the fixed code path.
    const rows = await getRepoMemory(TEST_OWNER, TEST_REPO, db);

    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.content).sort()).toEqual(["note A", "note B", "note C"]);

    const updatedRows: { id: string; last_read_at: Date | null }[] = await db`
      SELECT id, last_read_at FROM repo_memory
      WHERE repo_owner = ${TEST_OWNER} AND repo_name = ${TEST_REPO}
    `;
    expect(updatedRows.length).toBe(3);
    for (const row of updatedRows) {
      expect(row.last_read_at).not.toBeNull();
    }
  });

  it("deleteRepoMemories removes the requested ids without ANY() binding error", async () => {
    const db = requireSql();

    const seeded: { id: string }[] = await db`
      INSERT INTO repo_memory (repo_owner, repo_name, category, content, pinned)
      VALUES
        (${TEST_OWNER}, ${TEST_REPO}, 'gotchas', 'to-delete-1', false),
        (${TEST_OWNER}, ${TEST_REPO}, 'gotchas', 'to-delete-2', false),
        (${TEST_OWNER}, ${TEST_REPO}, 'gotchas', 'keep-me',     false)
      RETURNING id, content
    `;

    const ids = seeded.slice(0, 2).map((r) => r.id);
    const { deleteRepoMemories } = await import("../../src/orchestrator/repo-knowledge");

    const deletedCount = await deleteRepoMemories(ids, db);
    expect(deletedCount).toBe(2);

    const remaining: { content: string }[] = await db`
      SELECT content FROM repo_memory
      WHERE repo_owner = ${TEST_OWNER} AND repo_name = ${TEST_REPO}
        AND (content LIKE 'to-delete%' OR content = 'keep-me')
    `;
    const contents = remaining.map((r) => r.content);
    expect(contents).toContain("keep-me");
    expect(contents).not.toContain("to-delete-1");
    expect(contents).not.toContain("to-delete-2");
  });

  it("deleteRepoMemories with empty array is a no-op (does not query DB)", async () => {
    const db = requireSql();
    const { deleteRepoMemories } = await import("../../src/orchestrator/repo-knowledge");

    const result = await deleteRepoMemories([], db);
    expect(result).toBe(0);
  });
});
