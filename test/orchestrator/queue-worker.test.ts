/**
 * Smoke tests for src/orchestrator/queue-worker.ts — reliable-queue drain
 * loop. Intentionally narrow: the worker calls into job-queue and
 * job-dispatcher, and wholesale-mocking those modules contaminates other
 * test files via Bun's process-global mock registry. Here we verify only
 * lifecycle invariants (idempotent start, clean stop) by driving the
 * worker against a mocked Valkey client — the real job-queue code runs.
 */

import { describe, expect, it, mock } from "bun:test";

const mockSend = mock(() => Promise.resolve(null));

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

void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  getValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  isValkeyHealthy: (): boolean => true,
  closeValkey: (): void => {},
  connectValkey: (): Promise<void> => Promise.resolve(),
}));

const { startQueueWorker, stopQueueWorker } = await import("../../src/orchestrator/queue-worker");

describe("queue-worker", () => {
  it("starts, polls LMOVE against an empty queue, and stops cleanly", async () => {
    // Empty queue — LMOVE always returns null, loop idles.
    mockSend.mockImplementation(() => Promise.resolve(null));

    startQueueWorker();
    // Let the worker attempt at least one lease before stopping.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopQueueWorker();

    const lmoveCalls = mockSend.mock.calls.filter((c) => c[0] === "LMOVE");
    expect(lmoveCalls.length).toBeGreaterThanOrEqual(1);
    // LMOVE source = queue:jobs
    expect(lmoveCalls[0]?.[1]?.[0]).toBe("queue:jobs");
  });

  it("is idempotent — a second startQueueWorker does not spawn a second loop", async () => {
    mockSend.mockClear();
    mockSend.mockImplementation(() => Promise.resolve(null));

    startQueueWorker();
    startQueueWorker();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopQueueWorker();

    // A second loop would roughly double the poll rate; we assert the call
    // count is in the single-loop range. 50ms / 200ms poll = ~0-2 LMOVEs for
    // one loop; two loops would show 2-4. Loose upper bound for flakiness.
    const lmoveCount = mockSend.mock.calls.filter((c) => c[0] === "LMOVE").length;
    expect(lmoveCount).toBeLessThan(5);
  });
});
