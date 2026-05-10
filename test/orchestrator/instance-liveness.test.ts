/**
 * Tests for src/orchestrator/instance-liveness.ts: orchestrator liveness
 * heartbeat used by the cross-instance processing-list reaper.
 *
 * Note: the module owns a process-level `setInterval`. We only exercise the
 * public API on one ordered happy-path test to avoid the interval ticking
 * across test boundaries and interacting with other files' mock.module state.
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

const { startInstanceHeartbeat, stopInstanceHeartbeat, instanceAliveKey } =
  await import("../../src/orchestrator/instance-liveness");
const { getInstanceId } = await import("../../src/orchestrator/instance-id");

describe("instance-liveness", () => {
  it("writes orchestrator:{id}:alive with TTL, is idempotent, and DELs on stop", async () => {
    await startInstanceHeartbeat();
    const setCall = mockSend.mock.calls.find((c) => c[0] === "SET");
    expect(setCall?.[1]?.[0]).toBe(instanceAliveKey(getInstanceId()));
    expect(setCall?.[1]?.[1]).toBe("1");
    expect(setCall?.[1]?.[2]).toBe("EX");
    expect(Number(setCall?.[1]?.[3])).toBeGreaterThan(0);

    const callsBeforeSecondStart = mockSend.mock.calls.length;
    await startInstanceHeartbeat();
    // Second start is a no-op, no additional SETs.
    expect(mockSend.mock.calls.length).toBe(callsBeforeSecondStart);

    await stopInstanceHeartbeat();
    expect(mockSend).toHaveBeenCalledWith("DEL", [instanceAliveKey(getInstanceId())]);
  });
});
