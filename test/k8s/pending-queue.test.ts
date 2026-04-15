/**
 * Tests for src/k8s/pending-queue.ts — Valkey-backed FIFO pending queue +
 * in-flight tracker for the isolated-job dispatch target (T040 + T041).
 *
 * Covers:
 *   - enqueue below max → RPUSH + bot-context SETEX, returns position
 *   - enqueue at max → rejected-full, no RPUSH, no SETEX
 *   - FIFO ordering of dequeue (RPUSH / LPOP)
 *   - getPosition returns 1-indexed position, null when absent
 *   - dequeue returns context-missing when bot-context TTL expired
 *   - dequeue returns corrupt on schema-invalid or non-JSON entries
 *   - SADD / SREM / SCARD semantics for the in-flight tracker
 *   - releaseInFlight deletes bot-context (SREM + DEL pairing)
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PendingIsolatedJobEntry } from "../../src/k8s/pending-queue";
import type { SerializableBotContext } from "../../src/shared/daemon-types";

// ---------------------------------------------------------------------------
// Mock Valkey client
// ---------------------------------------------------------------------------

interface MockSend {
  (cmd: string, args: string[]): Promise<unknown>;
  mock: { calls: [string, string[]][] };
  mockClear(): void;
  mockImplementation(fn: (cmd: string, args: string[]) => Promise<unknown>): void;
}

const mockSend = mock((_cmd: string, _args: string[]) =>
  Promise.resolve(null as unknown),
) as unknown as MockSend;

void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  getValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  isValkeyHealthy: (): boolean => true,
  closeValkey: (): void => {},
}));

// Silence logger
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
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

const {
  BOT_CONTEXT_TTL_SECONDS,
  IN_FLIGHT_SET_KEY,
  PENDING_LIST_KEY,
  dequeuePending,
  enqueuePending,
  getPosition,
  inFlightCount,
  loadBotContext,
  pendingLength,
  registerInFlight,
  releaseInFlight,
  storeBotContext,
} = await import("../../src/k8s/pending-queue");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<PendingIsolatedJobEntry> = {}): PendingIsolatedJobEntry {
  return {
    deliveryId: "d-001",
    enqueuedAt: "2026-04-15T10:00:00.000Z",
    botContextKey: "bot-context:d-001",
    triageResult: null,
    dispatchReason: "label",
    maxTurns: 30,
    source: { owner: "o", repo: "r", issueOrPrNumber: 42 },
    ...overrides,
  };
}

function makeContext(deliveryId = "d-001"): SerializableBotContext {
  return {
    deliveryId,
    owner: "o",
    repo: "r",
    entityNumber: 42,
    isPR: true,
    eventName: "issue_comment",
    triggerUsername: "u",
    triggerBody: "hi",
    labels: [],
  } as unknown as SerializableBotContext;
}

/**
 * Install a script that returns responses for (cmd, key) lookups. Any
 * unregistered (cmd, key) pair resolves to `null`.
 */
function scriptSend(entries: Record<string, unknown>): void {
  mockSend.mockImplementation((cmd: string, args: string[]) => {
    const key = args[0] ?? "";
    const full = `${cmd} ${key}`;
    const cmdOnly = cmd;
    if (full in entries) return Promise.resolve(entries[full]);
    if (cmdOnly in entries) return Promise.resolve(entries[cmdOnly]);
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  mockSend.mockClear();
  mockSend.mockImplementation(() => Promise.resolve(null));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enqueuePending (atomic EVAL)", () => {
  // After Copilot PR #21 review: the check-then-act LLEN+RPUSH was replaced
  // with a single Lua EVAL that returns [status, length]. These tests mock
  // the EVAL response directly.

  it("passes the pending list, bot-context key, max, entry JSON, context JSON, and TTL as EVAL args", async () => {
    mockSend.mockImplementation((cmd: string) => {
      if (cmd === "EVAL") return Promise.resolve([1, 1]);
      return Promise.resolve(null);
    });

    await enqueuePending(makeEntry(), makeContext(), { maxQueueLength: 20 });

    const evalCall = mockSend.mock.calls.find((c) => c[0] === "EVAL");
    expect(evalCall).toBeDefined();
    const args = evalCall?.[1] ?? [];
    // [script, numKeys, key1, key2, max, entryJson, contextJson, ttl]
    expect(args[1]).toBe("2");
    expect(args[2]).toBe(PENDING_LIST_KEY);
    expect(args[3]).toBe("bot-context:d-001");
    expect(args[4]).toBe("20");
    const entryPayload = JSON.parse(args[5] ?? "null") as PendingIsolatedJobEntry;
    expect(entryPayload.deliveryId).toBe("d-001");
    expect(args[7]).toBe(String(BOT_CONTEXT_TTL_SECONDS));
  });

  it("returns 1-indexed position from the EVAL success tuple", async () => {
    mockSend.mockImplementation((cmd: string) => {
      if (cmd === "EVAL") return Promise.resolve([1, 3]);
      return Promise.resolve(null);
    });

    const r = await enqueuePending(makeEntry(), makeContext(), { maxQueueLength: 20 });

    expect(r.outcome).toBe("enqueued");
    if (r.outcome === "enqueued") expect(r.position).toBe(3);
  });

  it("returns rejected-full when the EVAL reject tuple fires; carries currentLength", async () => {
    mockSend.mockImplementation((cmd: string) => {
      if (cmd === "EVAL") return Promise.resolve([-1, 20]);
      return Promise.resolve(null);
    });

    const r = await enqueuePending(makeEntry(), makeContext(), { maxQueueLength: 20 });

    expect(r.outcome).toBe("rejected-full");
    if (r.outcome === "rejected-full") expect(r.currentLength).toBe(20);
  });

  it("makes exactly one Valkey round-trip (atomicity guarantee, not two check-then-acts)", async () => {
    mockSend.mockImplementation((cmd: string) => {
      if (cmd === "EVAL") return Promise.resolve([1, 1]);
      return Promise.resolve(null);
    });

    await enqueuePending(makeEntry(), makeContext(), { maxQueueLength: 20 });

    // Exactly one EVAL, zero standalone LLEN / SETEX / RPUSH.
    expect(mockSend.mock.calls.filter((c) => c[0] === "EVAL")).toHaveLength(1);
    expect(mockSend.mock.calls.find((c) => c[0] === "LLEN")).toBeUndefined();
    expect(mockSend.mock.calls.find((c) => c[0] === "SETEX")).toBeUndefined();
    expect(mockSend.mock.calls.find((c) => c[0] === "RPUSH")).toBeUndefined();
  });

  it("throws on schema-invalid entries (programming error, not queue-full)", async () => {
    mockSend.mockImplementation(() => Promise.resolve(null));

    let threw = false;
    try {
      await enqueuePending(
        { ...makeEntry(), deliveryId: "" } as PendingIsolatedJobEntry,
        makeContext(),
        { maxQueueLength: 20 },
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Schema validation short-circuits BEFORE EVAL fires — nothing should
    // have been written to Valkey on a programming error.
    expect(mockSend.mock.calls.find((c) => c[0] === "EVAL")).toBeUndefined();
  });
});

describe("dequeuePending", () => {
  it("returns empty when the list is empty (LPOP null)", async () => {
    scriptSend({ LPOP: null });

    const r = await dequeuePending();

    expect(r.outcome).toBe("empty");
  });

  it("returns parsed entry + bot-context on a clean LPOP", async () => {
    const entry = makeEntry();
    const ctx = makeContext();
    scriptSend({
      LPOP: JSON.stringify(entry),
      [`GET ${entry.botContextKey}`]: JSON.stringify(ctx),
    });

    const r = await dequeuePending();

    expect(r.outcome).toBe("dequeued");
    if (r.outcome === "dequeued") {
      expect(r.entry.deliveryId).toBe(entry.deliveryId);
      expect(r.context.deliveryId).toBe(entry.deliveryId);
    }
  });

  it("returns context-missing when bot-context TTL has expired (GET null)", async () => {
    const entry = makeEntry();
    scriptSend({
      LPOP: JSON.stringify(entry),
      [`GET ${entry.botContextKey}`]: null,
    });

    const r = await dequeuePending();

    expect(r.outcome).toBe("context-missing");
    if (r.outcome === "context-missing") expect(r.entry.deliveryId).toBe(entry.deliveryId);
  });

  it("returns corrupt on non-JSON payload (consumes the entry, does not requeue)", async () => {
    scriptSend({ LPOP: "not{json" });

    const r = await dequeuePending();

    expect(r.outcome).toBe("corrupt");
    // No RPUSH to the pending list to re-add the poisoned entry.
    expect(mockSend.mock.calls.find((c) => c[0] === "RPUSH")).toBeUndefined();
  });

  it("returns corrupt on schema-invalid payload", async () => {
    scriptSend({ LPOP: JSON.stringify({ wrong: "shape" }) });

    const r = await dequeuePending();

    expect(r.outcome).toBe("corrupt");
  });
});

describe("getPosition", () => {
  it("returns 1-indexed position when the delivery is queued", async () => {
    const a = makeEntry({ deliveryId: "a" });
    const b = makeEntry({ deliveryId: "b", botContextKey: "bot-context:b" });
    const c = makeEntry({ deliveryId: "c", botContextKey: "bot-context:c" });
    scriptSend({ LRANGE: [JSON.stringify(a), JSON.stringify(b), JSON.stringify(c)] });

    expect(await getPosition("a")).toBe(1);
    expect(await getPosition("b")).toBe(2);
    expect(await getPosition("c")).toBe(3);
  });

  it("returns null when the delivery is not in the queue", async () => {
    scriptSend({ LRANGE: [JSON.stringify(makeEntry())] });

    expect(await getPosition("missing")).toBeNull();
  });

  it("skips unparsable entries without throwing", async () => {
    const good = makeEntry({ deliveryId: "good" });
    scriptSend({ LRANGE: ["not{json", JSON.stringify(good)] });

    expect(await getPosition("good")).toBe(2);
  });
});

describe("in-flight tracker", () => {
  it("inFlightCount returns the SCARD result", async () => {
    scriptSend({ SCARD: 2 });
    expect(await inFlightCount()).toBe(2);
  });

  it("registerInFlight SADDs and returns the new count", async () => {
    let sadds = 0;
    mockSend.mockImplementation((cmd: string) => {
      if (cmd === "SADD") {
        sadds++;
        return Promise.resolve(1);
      }
      if (cmd === "SCARD") return Promise.resolve(sadds);
      return Promise.resolve(null);
    });

    const count = await registerInFlight("d-x");
    expect(count).toBe(1);
    const saddCall = mockSend.mock.calls.find((c) => c[0] === "SADD");
    expect(saddCall?.[1]).toEqual([IN_FLIGHT_SET_KEY, "d-x"]);
  });

  it("releaseInFlight SREMs AND deletes bot-context (pairing invariant)", async () => {
    scriptSend({});

    await releaseInFlight("d-y");

    const sremCall = mockSend.mock.calls.find((c) => c[0] === "SREM");
    const delCall = mockSend.mock.calls.find((c) => c[0] === "DEL");
    expect(sremCall?.[1]).toEqual([IN_FLIGHT_SET_KEY, "d-y"]);
    expect(delCall?.[1]).toEqual(["bot-context:d-y"]);
  });
});

describe("bot-context storage", () => {
  it("storeBotContext SETEXes with TTL", async () => {
    scriptSend({});
    await storeBotContext("d-z", makeContext("d-z"));
    const setex = mockSend.mock.calls.find((c) => c[0] === "SETEX");
    expect(setex?.[1][0]).toBe("bot-context:d-z");
    expect(setex?.[1][1]).toBe(String(BOT_CONTEXT_TTL_SECONDS));
  });

  it("loadBotContext returns null when the key is absent", async () => {
    scriptSend({ GET: null });
    expect(await loadBotContext("d-missing")).toBeNull();
  });

  it("loadBotContext returns null (non-fatal) on malformed JSON", async () => {
    scriptSend({ GET: "not{json" });
    expect(await loadBotContext("d-bad")).toBeNull();
  });

  it("loadBotContext returns the parsed context on success", async () => {
    const ctx = makeContext("d-ok");
    scriptSend({ GET: JSON.stringify(ctx) });
    const loaded = await loadBotContext("d-ok");
    expect(loaded?.deliveryId).toBe("d-ok");
  });
});

describe("pendingLength", () => {
  it("returns the LLEN result", async () => {
    scriptSend({ LLEN: 7 });
    expect(await pendingLength()).toBe(7);
  });
});
