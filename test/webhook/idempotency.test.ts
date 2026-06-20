/**
 * Issue #202: webhook delivery idempotency.
 *
 * `claimDelivery` is a Valkey SET-NX-EX claim that returns true exactly once
 * per deliveryId (the first caller proceeds), false on a redelivery, and
 * fail-OPEN (true) whenever Valkey is unavailable or errors.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Logger } from "pino";

import { IdempotencyLogFieldsSchema } from "../../src/webhook/idempotency-log-fields";

// Configurable Valkey stub: the mock is wired once at module load (below);
// each test swaps `clientImpl` (and `healthy`) before invoking claimDelivery.
// getValkeyClient returns whatever clientImpl holds at call time.
type SendFn = (cmd: string, args: string[]) => Promise<unknown>;
let clientImpl: { send: SendFn } | null = null;
let healthy = true;

// `isValkeyHealthy` gates the SET: the non-null-client cases need it true to
// reach the command; the null-client case short-circuits on `client === null`
// before it is read; the configured-but-down case sets it false.
void mock.module("../../src/orchestrator/valkey", () => ({
  getValkeyClient: () => clientImpl,
  isValkeyHealthy: () => healthy,
}));

const { claimDelivery } = await import("../../src/webhook/idempotency");

// Recording logger: captures the structured field object of each emit and
// parses it through the canonical schema AT CAPTURE TIME, so every emitted line
// (not only those a test later asserts on) is held to the strict contract. A
// stray/misnamed field, a `reason` on the wrong event, or `err` on the
// `unavailable` path throws here, surfacing the offending test directly.
type Level = "debug" | "info" | "warn";
let logged: { level: Level; fields: Record<string, unknown> }[] = [];
function record(level: Level) {
  return (fields: Record<string, unknown>) => {
    IdempotencyLogFieldsSchema.parse(fields);
    logged.push({ level, fields });
  };
}
const log = {
  debug: record("debug"),
  info: record("info"),
  warn: record("warn"),
} as unknown as Logger;

// Assert an emit with `event` was captured (its schema validity is already
// guaranteed by the capture-time parse above) and return its fields.
function expectEmittedEvent(event: string): Record<string, unknown> {
  const rec = logged.find((r) => r.fields.event === event);
  expect(rec).toBeDefined();
  return rec?.fields ?? {};
}

// SET-NX-EX semantics: first SET of a key returns "OK", a second SET of the
// same key returns null (the key already exists). Mirrors real Valkey NX.
function nxClient(): { send: SendFn; store: Set<string> } {
  const store = new Set<string>();
  return {
    store,
    send: (cmd, args) => {
      if (cmd !== "SET") return Promise.resolve(null);
      const key = args[0] ?? "";
      const hasNx = args.includes("NX");
      if (hasNx && store.has(key)) return Promise.resolve(null);
      store.add(key);
      return Promise.resolve("OK");
    },
  };
}

describe("claimDelivery (issue #202)", () => {
  beforeEach(() => {
    clientImpl = null;
    healthy = true;
    logged = [];
  });

  it("claims a new delivery once, then rejects the redelivery", async () => {
    clientImpl = nxClient();
    const first = await claimDelivery("delivery-abc", log);
    const second = await claimDelivery("delivery-abc", log);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expectEmittedEvent("idempotency.claimed");
    expectEmittedEvent("idempotency.duplicate_skipped");
  });

  it("treats distinct deliveryIds independently", async () => {
    clientImpl = nxClient();
    expect(await claimDelivery("delivery-1", log)).toBe(true);
    expect(await claimDelivery("delivery-2", log)).toBe(true);
  });

  it("issues SET with NX and a 3-day EX TTL", async () => {
    const calls: string[][] = [];
    clientImpl = {
      send: (cmd, args) => {
        calls.push([cmd, ...args]);
        return Promise.resolve("OK");
      },
    };
    await claimDelivery("delivery-ttl", log);
    expect(calls).toEqual([["SET", "idemp:webhook:delivery-ttl", "1", "NX", "EX", "259200"]]);
  });

  it("fails OPEN (true) when Valkey is unconfigured (null client)", async () => {
    clientImpl = null;
    expect(await claimDelivery("delivery-no-valkey", log)).toBe(true);
    expect(expectEmittedEvent("idempotency.failed_open").reason).toBe("unavailable");
  });

  it("fails OPEN (true) when the Valkey SET throws", async () => {
    clientImpl = {
      send: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    expect(await claimDelivery("delivery-error", log)).toBe(true);
    const failed = expectEmittedEvent("idempotency.failed_open");
    expect(failed.reason).toBe("error");
    expect(failed.err).toBe("ECONNREFUSED");
  });

  it("fails OPEN (true) without issuing SET when configured-but-disconnected", async () => {
    // Non-null client (VALKEY_URL set) but the connection is down: gating on
    // isValkeyHealthy() must skip the SET (which would otherwise queue/block
    // under Bun's default enableOfflineQueue) and fail open immediately.
    let sendCalled = false;
    clientImpl = {
      send: () => {
        sendCalled = true;
        return Promise.resolve("OK");
      },
    };
    healthy = false;
    expect(await claimDelivery("delivery-disconnected", log)).toBe(true);
    expect(sendCalled).toBe(false);
  });
});
