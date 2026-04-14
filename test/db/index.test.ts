/**
 * Tests for src/db/index.ts — the database connection pool singleton.
 *
 * The SQL constructor from Bun is a built-in that cannot be replaced via
 * mock.module("bun"). However, `new SQL(url)` is lazy — it doesn't attempt
 * an actual connection until a query is executed, and `close()` is a no-op
 * on an idle pool. This lets us exercise every code path with a dummy URL
 * and no running database.
 *
 * Module state (the `pool` singleton) is reset between tests by calling
 * closeDb() in afterEach. We import once (not per test) so Bun's coverage
 * instrument can attribute the lines.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLoggerInfo = mock(() => undefined);

// Mutable config reference — tests mutate databaseUrl between runs
const mockConfig: { databaseUrl: string | undefined } = {
  databaseUrl: undefined,
};

void mock.module("../../src/config", () => ({
  config: mockConfig,
}));

void mock.module("../../src/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: (): undefined => undefined,
    error: (): undefined => undefined,
    debug: (): undefined => undefined,
    child: (): {
      info: () => undefined;
      warn: () => undefined;
      error: () => undefined;
      debug: () => undefined;
    } => ({
      info: (): undefined => undefined,
      warn: (): undefined => undefined,
      error: (): undefined => undefined,
      debug: (): undefined => undefined,
    }),
  },
}));

// Single import — keeps coverage attribution consistent.
import { closeDb, getDb, requireDb } from "../../src/db/index";

/** Dummy URL that satisfies the SQL constructor but never connects (lazy pool). */
const DUMMY_URL = "postgres://test:test@localhost:59999/nonexistent";

// ─── Test Suite ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockLoggerInfo.mockClear();
  mockConfig.databaseUrl = undefined;
});

afterEach(async () => {
  // Reset the pool singleton after each test
  await closeDb();
});

// ─── getDb ──────────────────────────────────────────────────────────────

describe("getDb", () => {
  it("returns null when DATABASE_URL is not configured", () => {
    mockConfig.databaseUrl = undefined;

    const result = getDb();

    expect(result).toBeNull();
  });

  it("creates and returns a SQL pool when DATABASE_URL is configured", () => {
    mockConfig.databaseUrl = DUMMY_URL;

    const result = getDb();

    expect(result).not.toBeNull();
    expect(typeof result).toBe("function"); // Bun SQL instances are callable
    if (result === null) {
      throw new Error("Expected result to be non-null");
    }
    expect(typeof result.close).toBe("function");
    expect(mockLoggerInfo).toHaveBeenCalledWith("Database connection pool initialized");
  });

  it("returns the cached pool on subsequent calls (singleton pattern)", () => {
    mockConfig.databaseUrl = DUMMY_URL;

    const first = getDb();
    mockLoggerInfo.mockClear();

    const second = getDb();

    expect(first).toBe(second);
    // Should not log "initialized" again — mockClear above resets call count
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});

// ─── requireDb ──────────────────────────────────────────────────────────

describe("requireDb", () => {
  it("throws when DATABASE_URL is not configured", () => {
    mockConfig.databaseUrl = undefined;

    expect(() => requireDb()).toThrow(
      "DATABASE_URL is not configured but database access was requested",
    );
  });

  it("returns the SQL pool when DATABASE_URL is configured", () => {
    mockConfig.databaseUrl = DUMMY_URL;

    const result = requireDb();

    expect(result).not.toBeNull();
    expect(typeof result.close).toBe("function");
  });
});

// ─── closeDb ──────────────────────────────────────────────────────────

describe("closeDb", () => {
  it("is a no-op when pool has not been initialized", async () => {
    // pool is null by default (no getDb() call, no databaseUrl)
    await closeDb();

    // Should not log "closed" since there was nothing to close
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it("closes the pool and logs when pool was initialized", async () => {
    mockConfig.databaseUrl = DUMMY_URL;
    getDb(); // initialize the pool
    mockLoggerInfo.mockClear(); // clear the "initialized" log

    await closeDb();

    expect(mockLoggerInfo).toHaveBeenCalledWith("Database connection pool closed");
  });

  it("sets pool to null so subsequent getDb() re-initializes", async () => {
    mockConfig.databaseUrl = DUMMY_URL;
    const first = getDb();
    await closeDb();
    mockLoggerInfo.mockClear();

    const second = getDb();

    // Should be a new instance (not the same reference)
    expect(second).not.toBe(first);
    expect(mockLoggerInfo).toHaveBeenCalledWith("Database connection pool initialized");
  });
});
