#!/usr/bin/env bun
/**
 * Standalone migration runner.
 *
 * Why: `src/app.ts` runs migrations on boot, but ops + CI need a way to
 * apply migrations without booting the whole webhook server. Importing
 * `requireDb` + `runMigrations` keeps the script tiny: the
 * connection-pool and DDL logic stays in `src/db/`.
 */

import { closeDb, requireDb } from "../src/db";
import { runMigrations } from "../src/db/migrate";
import { logger } from "../src/logger";

async function main(): Promise<void> {
  const db = requireDb();
  try {
    await runMigrations(db);
    logger.info("Migrations applied successfully");
  } finally {
    await closeDb();
  }
}

await main();
