/**
 * Tests for src/orchestrator/valkey-cleanup.ts — startup orphan sweep.
 * Drives the cleanup against a mocked Valkey client so we don't need to
 * mock the job-queue module (which would leak across files via Bun's
 * process-global mock.module registry).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

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

const mockSend = mock((..._args: unknown[]) => Promise.resolve(null as unknown));

void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  getValkeyClient: (): { send: typeof mockSend } => ({ send: mockSend }),
  isValkeyHealthy: (): boolean => true,
  closeValkey: (): void => {},
  connectValkey: (): Promise<void> => Promise.resolve(),
}));

const { sweepValkeyOrphans, reapOrphanProcessingLists } =
  await import("../../src/orchestrator/valkey-cleanup");

type ScanReply = [string, string[]];

function scanOnce(keys: string[]): ScanReply {
  return ["0", keys];
}

describe("valkey-cleanup", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("deletes active_jobs keys whose liveness key no longer exists", async () => {
    mockSend.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === "SCAN") {
        const pattern = (args as string[])[2];
        if (pattern === "daemon:*:active_jobs") {
          return Promise.resolve(scanOnce(["daemon:a:active_jobs", "daemon:b:active_jobs"]));
        }
        return Promise.resolve(scanOnce([]));
      }
      if (cmd === "EXISTS") {
        const key = (args as string[])[0];
        return Promise.resolve(key === "daemon:b" ? 1 : 0);
      }
      if (cmd === "SMEMBERS") return Promise.resolve([]);
      if (cmd === "LMOVE") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    await sweepValkeyOrphans("orch-self");

    expect(mockSend).toHaveBeenCalledWith("DEL", ["daemon:a:active_jobs"]);
    expect(mockSend).not.toHaveBeenCalledWith("DEL", ["daemon:b:active_jobs"]);
  });

  it("SREMs active_daemons members whose liveness key is gone", async () => {
    mockSend.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === "SCAN") return Promise.resolve(scanOnce([]));
      if (cmd === "SMEMBERS") return Promise.resolve(["d-alive", "d-dead"]);
      if (cmd === "EXISTS") {
        const key = (args as string[])[0];
        return Promise.resolve(key === "daemon:d-alive" ? 1 : 0);
      }
      if (cmd === "LMOVE") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    await sweepValkeyOrphans("orch-self");

    expect(mockSend).toHaveBeenCalledWith("SREM", ["active_daemons", "d-dead"]);
    expect(mockSend).not.toHaveBeenCalledWith("SREM", ["active_daemons", "d-alive"]);
  });

  it("skips the self-owned processing list during cross-instance reap", async () => {
    mockSend.mockImplementation((cmd: unknown, args: unknown) => {
      if (cmd === "SCAN") {
        const pattern = (args as string[])[2];
        if (pattern === "queue:processing:*") {
          return Promise.resolve(
            scanOnce(["queue:processing:orch-self", "queue:processing:orch-dead"]),
          );
        }
        return Promise.resolve(scanOnce([]));
      }
      if (cmd === "EXISTS") return Promise.resolve(0); // orch-dead heartbeat absent
      if (cmd === "SMEMBERS") return Promise.resolve([]);
      if (cmd === "LMOVE") {
        // Drain: first call returns one item, second returns null (source empty).
        const src = (args as string[])[0];
        if (src === "queue:processing:orch-dead") {
          return Promise.resolve("job-json-placeholder");
        }
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const recovered = await reapOrphanProcessingLists("orch-self");

    expect(recovered).toBeGreaterThan(0);
    // Self-owned list is skipped — LMOVE never called with orch-self as source.
    const selfDrainAttempt = mockSend.mock.calls.find(
      (c) => c[0] === "LMOVE" && (c[1] as string[])[0] === "queue:processing:orch-self",
    );
    expect(selfDrainAttempt).toBeUndefined();
  });

  it("leaves processing lists of live instances alone", async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd === "SCAN") return Promise.resolve(scanOnce(["queue:processing:orch-alive"]));
      if (cmd === "EXISTS") return Promise.resolve(1); // heartbeat present
      if (cmd === "SMEMBERS") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const recovered = await reapOrphanProcessingLists("orch-self");

    expect(recovered).toBe(0);
    // Drain LMOVE never invoked because the owner is alive.
    const lmove = mockSend.mock.calls.find((c) => c[0] === "LMOVE");
    expect(lmove).toBeUndefined();
  });
});
