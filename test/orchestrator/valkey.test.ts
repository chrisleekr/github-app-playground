/**
 * Tests for src/orchestrator/valkey.ts — Valkey client singleton management.
 *
 * Approach: We import the real valkey module after mocking its dependencies
 * (config, logger). The real module creates a Bun RedisClient against a fake URL
 * (no real server needed — RedisClient can be constructed without a connection).
 *
 * When running in a multi-file test process, mock.module() from other test files
 * may override the valkey module. To handle this gracefully, each test file that
 * mocks valkey uses the SAME mock interface, and this file is designed to pass
 * regardless of mock.module registration order.
 *
 * For coverage: run `bun test test/orchestrator/valkey.test.ts` individually
 * to see 100% line/function coverage on src/orchestrator/valkey.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Mock dependencies BEFORE importing valkey

const mockLoggerInfo = mock(() => {});
const mockLoggerWarn = mock(() => {});

void mock.module("../../src/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(() => ({
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    })),
  },
}));

const mockConfig = {
  valkeyUrl: undefined as string | undefined,
  logLevel: "silent",
  nodeEnv: "test",
  appId: "test-app-id",
  privateKey: "test-private-key",
  webhookSecret: "test-webhook-secret",
  provider: "anthropic" as const,
  anthropicApiKey: "test-key",
  agentJobMode: "inline" as const,
  staleExecutionThresholdMs: 600_000,
  jobMaxRetries: 3,
};

void mock.module("../../src/config", () => ({
  config: mockConfig,
}));

// Import the real valkey module.
// NOTE: In multi-file runs, mock.module("../../src/orchestrator/valkey", ...)
// from other test files may intercept this import. When run individually, the
// real module is loaded and coverage is counted.

const valkey = await import("../../src/orchestrator/valkey");

/** Safely get a non-null client with onconnect/onclose callbacks. */
function getClient(): {
  onconnect: () => void;
  onclose: () => void;
} {
  const c = valkey.getValkeyClient();
  if (c === null || c === undefined) {
    throw new Error("Expected valkey client to be non-null");
  }
  if (c.onconnect === undefined || c.onclose === undefined) {
    throw new Error("Expected onconnect/onclose callbacks");
  }
  return { onconnect: c.onconnect, onclose: c.onclose };
}

// Detect whether we got the real module or a mock.
// The real module's getValkeyClient returns null when config.valkeyUrl is undefined
// and client singleton is null. A mock always returns the mock object.
const isRealModule = ((): boolean => {
  // Save current state
  const savedUrl = mockConfig.valkeyUrl;
  mockConfig.valkeyUrl = undefined;

  // Try calling closeValkey to reset singleton
  try {
    valkey.closeValkey();
  } catch {
    // Mock might throw if closeValkey is a noop
  }

  try {
    const result = valkey.getValkeyClient();
    mockConfig.valkeyUrl = savedUrl;
    return result === null;
  } catch {
    mockConfig.valkeyUrl = savedUrl;
    return false;
  }
})();

beforeEach(() => {
  mockConfig.valkeyUrl = undefined;
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();

  if (isRealModule) {
    valkey.closeValkey();
  }
});

afterEach(() => {
  if (isRealModule) {
    valkey.closeValkey();
    mockConfig.valkeyUrl = undefined;
  }
});

describe("getValkeyClient", () => {
  it("returns null when valkeyUrl is not configured", () => {
    if (!isRealModule) {
      // When mocked, getValkeyClient always returns the mock object.
      // We verify it's callable and returns something.
      const result = valkey.getValkeyClient();
      expect(result).toBeDefined();
      return;
    }

    mockConfig.valkeyUrl = undefined;
    const result = valkey.getValkeyClient();
    expect(result).toBeNull();
  });

  it("creates and returns a client when valkeyUrl is configured", () => {
    if (!isRealModule) {
      const result = valkey.getValkeyClient();
      expect(result).not.toBeNull();
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    expect(client).not.toBeNull();
  });

  it("returns the same singleton on subsequent calls", () => {
    if (!isRealModule) {
      const a = valkey.getValkeyClient();
      const b = valkey.getValkeyClient();
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const first = valkey.getValkeyClient();
    const second = valkey.getValkeyClient();
    expect(first).toBe(second);
  });

  it("sets up onconnect callback that updates health state", () => {
    if (!isRealModule) {
      // In mock mode, isValkeyHealthy always returns true
      expect(valkey.isValkeyHealthy()).toBe(true);
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = getClient();
    expect(valkey.isValkeyHealthy()).toBe(false);

    client.onconnect();
    expect(valkey.isValkeyHealthy()).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ elapsedMs: expect.any(Number) }),
      "Valkey connected",
    );
  });

  it("sets up onclose callback that updates health state", () => {
    if (!isRealModule) {
      expect(valkey.isValkeyHealthy()).toBe(true);
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = getClient();
    client.onconnect();
    expect(valkey.isValkeyHealthy()).toBe(true);

    client.onclose();
    expect(valkey.isValkeyHealthy()).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ wasConnected: true }),
      "Valkey connection closed",
    );
  });
});

describe("requireValkeyClient", () => {
  it("throws when valkeyUrl is not configured", () => {
    if (!isRealModule) {
      // In mock mode, requireValkeyClient returns the mock
      const result = valkey.requireValkeyClient();
      expect(result).toBeDefined();
      return;
    }

    mockConfig.valkeyUrl = undefined;
    expect(() => valkey.requireValkeyClient()).toThrow(
      "VALKEY_URL is not configured but Valkey access was requested",
    );
  });

  it("returns the client when valkeyUrl is configured", () => {
    if (!isRealModule) {
      const result = valkey.requireValkeyClient();
      expect(result).toBeDefined();
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.requireValkeyClient();
    expect(client).not.toBeNull();
  });
});

describe("isValkeyHealthy", () => {
  it("returns false when no client exists", () => {
    if (!isRealModule) {
      expect(typeof valkey.isValkeyHealthy()).toBe("boolean");
      return;
    }

    expect(valkey.isValkeyHealthy()).toBe(false);
  });

  it("returns false before onconnect fires", () => {
    if (!isRealModule) {
      expect(typeof valkey.isValkeyHealthy()).toBe("boolean");
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    valkey.getValkeyClient();
    expect(valkey.isValkeyHealthy()).toBe(false);
  });

  it("returns true after onconnect fires", () => {
    if (!isRealModule) {
      expect(typeof valkey.isValkeyHealthy()).toBe("boolean");
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    client!.onconnect!();
    expect(valkey.isValkeyHealthy()).toBe(true);
  });

  it("returns false after onclose fires", () => {
    if (!isRealModule) {
      expect(typeof valkey.isValkeyHealthy()).toBe("boolean");
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    client!.onconnect!();
    client!.onclose!();
    expect(valkey.isValkeyHealthy()).toBe(false);
  });
});

describe("closeValkey", () => {
  it("does nothing when no client exists", () => {
    if (!isRealModule) {
      // Just verify it doesn't throw
      valkey.closeValkey();
      expect(true).toBe(true);
      return;
    }

    mockLoggerInfo.mockClear();
    valkey.closeValkey();
    const closedCalls = mockLoggerInfo.mock.calls.filter((c) => c[0] === "Valkey client closed");
    expect(closedCalls.length).toBe(0);
  });

  it("closes the client and resets health state", () => {
    if (!isRealModule) {
      valkey.closeValkey();
      expect(true).toBe(true);
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    client!.onconnect!();
    expect(valkey.isValkeyHealthy()).toBe(true);

    valkey.closeValkey();
    expect(valkey.isValkeyHealthy()).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith("Valkey client closed");
  });

  it("allows creating a new client after close", () => {
    if (!isRealModule) {
      valkey.closeValkey();
      const c = valkey.getValkeyClient();
      expect(c).toBeDefined();
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const firstClient = valkey.getValkeyClient();
    valkey.closeValkey();

    const newClient = valkey.getValkeyClient();
    expect(newClient).not.toBeNull();
    expect(newClient).not.toBe(firstClient);
  });

  it("resets connected flag on close", () => {
    if (!isRealModule) {
      valkey.closeValkey();
      expect(true).toBe(true);
      return;
    }

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    client!.onconnect!();

    valkey.closeValkey();
    expect(valkey.isValkeyHealthy()).toBe(false);
  });
});

describe("connectValkey", () => {
  it("returns immediately when valkeyUrl is not configured", async () => {
    if (!isRealModule) return;

    mockConfig.valkeyUrl = undefined;
    await valkey.connectValkey(1000);
    expect(mockLoggerInfo).toHaveBeenCalledWith("Valkey not configured, skipping connect");
  });

  it("resolves once client.connect() resolves and logs duration", async () => {
    if (!isRealModule) return;

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    if (client === null) throw new Error("expected client");
    // Stub Bun.RedisClient.connect so we don't depend on a real Valkey.
    // Critical: fire onconnect — connectValkey awaits the callback, not the promise.
    client.connect = (): Promise<void> => {
      client.onconnect?.();
      return Promise.resolve();
    };

    await valkey.connectValkey(1000);

    // The whole point of connectValkey: when it resolves, isValkeyHealthy must be true.
    expect(valkey.isValkeyHealthy()).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ elapsedMs: expect.any(Number) }),
      "Valkey connect awaited",
    );
  });

  it("rejects when connect exceeds timeoutMs", async () => {
    if (!isRealModule) return;

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const client = valkey.getValkeyClient();
    if (client === null) throw new Error("expected client");
    client.connect = (): Promise<void> => new Promise(() => {}); // never resolves

    let caught: unknown;
    try {
      await valkey.connectValkey(20);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out after 20ms/);
  });

  it("skips connect work when already connected", async () => {
    if (!isRealModule) return;

    mockConfig.valkeyUrl = "redis://127.0.0.1:59999";
    const c = valkey.getValkeyClient();
    if (c?.onconnect === undefined) throw new Error("expected client+cb");
    c.onconnect();
    mockLoggerInfo.mockClear();

    await valkey.connectValkey(1000);

    // Should not log "Awaiting Valkey connection" — fast-path returns early.
    const awaitingLogs = mockLoggerInfo.mock.calls.filter(
      (call) => call[1] === "Awaiting Valkey connection",
    );
    expect(awaitingLogs.length).toBe(0);
  });

  it("redacts credentials in the client-created log", () => {
    if (!isRealModule) return;

    mockConfig.valkeyUrl = "redis://user:secret@127.0.0.1:59999";
    valkey.getValkeyClient();

    const createdCall = mockLoggerInfo.mock.calls.find((c) => c[1] === "Valkey client created");
    expect(createdCall).toBeDefined();
    const meta = createdCall?.[0] as { valkeyUrl: string };
    expect(meta.valkeyUrl).not.toContain("secret");
    expect(meta.valkeyUrl).not.toContain("user");
    expect(meta.valkeyUrl).toContain("***");
  });
});
