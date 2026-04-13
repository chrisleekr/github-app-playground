import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SQL } from "bun";

import { logger } from "../logger";

// Use process.cwd() (project root) instead of import.meta.dir because Bun.build
// bundles TS→JS into dist/ but does not copy .sql files. In production Docker,
// CWD is /app (project root) so src/db/migrations/ is always accessible.
const MIGRATIONS_DIR = join(process.cwd(), "src/db/migrations");

/**
 * Run all pending SQL migrations in order.
 *
 * Tracks applied migrations in a `_migrations` table. Each migration runs
 * inside a transaction for atomicity — if a migration fails, the transaction
 * is rolled back and subsequent migrations are not attempted.
 *
 * Migration files are plain `.sql` files in `src/db/migrations/`, sorted by
 * filename (use numeric prefixes like `001_`, `002_` for ordering).
 */
export async function runMigrations(sql: SQL): Promise<void> {
  // Verify connectivity before attempting migrations — produces a clear error
  // instead of a raw Postgres connection failure deep in a DDL statement.
  try {
    await sql`SELECT 1`;
  } catch (err) {
    throw new Error(
      `Cannot connect to database: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Ensure the tracking table exists (idempotent)
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Get already-applied versions
  const applied: { version: string }[] = await sql`
    SELECT version FROM _migrations ORDER BY version
  `;
  const appliedSet = new Set(applied.map((r) => r.version));

  // Read migration files, sorted by filename

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (appliedSet.has(version)) {
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is join()-constructed from controlled dir
    const content = readFileSync(filePath, "utf-8");

    logger.info({ version, file }, "Applying migration");

    // eslint-disable-next-line no-await-in-loop -- migrations must run sequentially
    await sql.begin(async (tx) => {
      // unsafe() allows multi-statement SQL (DDL, CREATE TABLE, etc.)
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (version) VALUES (${version})`;
    });

    logger.info({ version }, "Migration applied successfully");
  }
}
