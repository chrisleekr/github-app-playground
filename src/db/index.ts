import { SQL } from "bun";

import { config } from "../config";
import { logger } from "../logger";

/**
 * Postgres connection pool singleton.
 * Lazy-initialized on first access: inline-mode deployments (no DATABASE_URL)
 * never open a connection.
 */
let pool: SQL | null = null;

/**
 * Get the database connection pool.
 * Returns null when DATABASE_URL is not configured (inline mode).
 */
export function getDb(): SQL | null {
  if (pool !== null) return pool;
  if (config.databaseUrl === undefined) return null;

  pool = new SQL(config.databaseUrl);
  logger.info("Database connection pool initialized");
  return pool;
}

/**
 * Get the database connection pool, throwing if not configured.
 * Use in code paths that require database access (non-inline modes).
 */
export function requireDb(): SQL {
  const db = getDb();
  if (db === null) {
    throw new Error("DATABASE_URL is not configured but database access was requested");
  }
  return db;
}

/**
 * Close the connection pool. Called during graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  // Capture reference before awaiting to avoid interleaving reads.
  const current = pool;
  if (current !== null) {
    pool = null;
    await current.close();
    logger.info("Database connection pool closed");
  }
}
