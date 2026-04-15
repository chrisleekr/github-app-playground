/**
 * Tests for src/k8s/pending-queue-drainer.ts — background drain of the
 * isolated-job pending queue (T044, US3).
 *
 * Exercises all four dequeue outcomes (empty / dequeued / context-missing /
 * corrupt) plus the in-flight capacity gate, the overlap-guard (two
 * concurrent ticks share a single promise), and the spawn-failure no-retry
 * invariant (FR-021).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PendingIsolatedJobEntry } from "../../src/k8s/pending-queue";
import type { SerializableBotContext } from "../../src/shared/daemon-types";

// ---------------------------------------------------------------------------
// Mocks — set up BEFORE importing the subject module so dynamic mocks take
// effect on first import.
// ---------------------------------------------------------------------------

const mockInFlightCount = mock(() => Promise.resolve(0));
const mockDequeuePending = mock(() =>
  Promise.resolve({ outcome: "empty" } as unknown as DequeueResult),
);
const mockRegisterInFlight = mock(() => Promise.resolve(1));
const mockReleaseInFlight = mock(() => Promise.resolve());
const mockSpawnIsolatedJob = mock(() => Promise.resolve({ success: true, durationMs: 0 }));

type DequeueResult =
  | { outcome: "empty" }
  | { outcome: "dequeued"; entry: PendingIsolatedJobEntry; context: SerializableBotContext }
  | { outcome: "context-missing"; entry: PendingIsolatedJobEntry }
  | { outcome: "corrupt"; raw: string; error: string };

void mock.module("../../src/k8s/pending-queue", () => ({
  inFlightCount: mockInFlightCount,
  dequeuePending: mockDequeuePending,
  registerInFlight: mockRegisterInFlight,
  releaseInFlight: mockReleaseInFlight,
}));

const mockWatchJobCompletion = mock(() => Promise.resolve("succeeded" as const));

void mock.module("../../src/k8s/job-spawner", () => ({
  spawnIsolatedJob: mockSpawnIsolatedJob,
  watchJobCompletion: mockWatchJobCompletion,
  JobSpawnerError: class JobSpawnerError extends Error {
    constructor(
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

// Silence logger + avoid pulling real pino streams into the mock.
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
  createChildLogger: (): Record<string, (..._args: unknown[]) => void> => ({
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    debug: (): void => {},
  }),
}));

const { drainPendingOnce } = await import("../../src/k8s/pending-queue-drainer");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<PendingIsolatedJobEntry> = {}): PendingIsolatedJobEntry {
  return {
    deliveryId: "d-drain-1",
    enqueuedAt: "2026-04-15T10:00:00.000Z",
    botContextKey: "bot-context:d-drain-1",
    triageResult: null,
    dispatchReason: "label",
    maxTurns: 30,
    source: { owner: "o", repo: "r", issueOrPrNumber: 42 },
    ...overrides,
  };
}

function makeContext(deliveryId = "d-drain-1"): SerializableBotContext {
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
    defaultBranch: "main",
    triggerTimestamp: "2026-04-15T10:00:00.000Z",
    commentId: 1,
  } as unknown as SerializableBotContext;
}

/**
 * Fake `App` — only the surfaces the drainer actually uses
 * (`octokit.rest.apps.getRepoInstallation` + `getInstallationOctokit`).
 */
function makeApp(): {
  octokit: { rest: { apps: { getRepoInstallation: ReturnType<typeof mock> } } };
  getInstallationOctokit: ReturnType<typeof mock>;
} {
  return {
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: mock(() => Promise.resolve({ data: { id: 123 } })),
        },
      },
    },
    getInstallationOctokit: mock(() => Promise.resolve({} as unknown)),
  };
}

beforeEach(() => {
  mockInFlightCount.mockClear();
  mockDequeuePending.mockClear();
  mockRegisterInFlight.mockClear();
  mockReleaseInFlight.mockClear();
  mockSpawnIsolatedJob.mockClear();
  mockInFlightCount.mockImplementation(() => Promise.resolve(0));
  mockDequeuePending.mockImplementation(() =>
    Promise.resolve({ outcome: "empty" } as unknown as DequeueResult),
  );
  mockRegisterInFlight.mockImplementation(() => Promise.resolve(1));
  mockReleaseInFlight.mockImplementation(() => Promise.resolve());
  mockSpawnIsolatedJob.mockImplementation(() => Promise.resolve({ success: true, durationMs: 0 }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drainPendingOnce — empty queue", () => {
  it("returns immediately when the queue is empty", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);
    expect(mockInFlightCount).toHaveBeenCalledTimes(1);
    expect(mockDequeuePending).toHaveBeenCalledTimes(1);
    expect(mockSpawnIsolatedJob).not.toHaveBeenCalled();
  });
});

describe("drainPendingOnce — capacity gate", () => {
  it("returns without dequeuing when in-flight is at max", async () => {
    mockInFlightCount.mockImplementation(() => Promise.resolve(3)); // == config.maxConcurrentIsolatedJobs default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);
    expect(mockInFlightCount).toHaveBeenCalledTimes(1);
    expect(mockDequeuePending).not.toHaveBeenCalled();
  });
});

describe("drainPendingOnce — dequeued path", () => {
  it("spawns and registers in-flight on a clean dequeue", async () => {
    const entry = makeEntry();
    const ctx = makeContext();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ outcome: "dequeued", entry, context: ctx } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight.mock.calls[0]?.[0]).toBe(entry.deliveryId);
    expect(mockReleaseInFlight).not.toHaveBeenCalled();
  });

  it("carries dispatchReason + maxTurns + triage complexity into the decision passed to spawn", async () => {
    const entry = makeEntry({
      dispatchReason: "triage",
      maxTurns: 50,
      triageResult: {
        mode: "isolated-job",
        confidence: 1,
        complexity: "complex",
        rationale: "big change",
      },
    });
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    const decisionArg = mockSpawnIsolatedJob.mock.calls[0]?.[1] as {
      target: string;
      reason: string;
      maxTurns: number;
      complexity?: string;
    };
    expect(decisionArg.target).toBe("isolated-job");
    expect(decisionArg.reason).toBe("triage");
    expect(decisionArg.maxTurns).toBe(50);
    expect(decisionArg.complexity).toBe("complex");
  });

  it("does NOT set complexity on the decision when the queue entry has no triageResult", async () => {
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry: makeEntry({ triageResult: null }),
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    const decisionArg = mockSpawnIsolatedJob.mock.calls[0]?.[1] as {
      complexity?: string;
    };
    expect(decisionArg.complexity).toBeUndefined();
  });
});

describe("drainPendingOnce — context-missing path", () => {
  it("logs and skips without spawning", async () => {
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "context-missing",
          entry: makeEntry(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    expect(mockSpawnIsolatedJob).not.toHaveBeenCalled();
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
  });
});

describe("drainPendingOnce — corrupt path", () => {
  it("logs and skips without spawning; subsequent clean dequeue still runs", async () => {
    const entry = makeEntry({ deliveryId: "d-clean" });
    const ctx = makeContext("d-clean");
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "corrupt",
          raw: "not{json",
          error: "unexpected",
        } as DequeueResult);
      }
      if (calls === 2) {
        return Promise.resolve({ outcome: "dequeued", entry, context: ctx } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight.mock.calls[0]?.[0]).toBe("d-clean");
  });
});

describe("drainPendingOnce — spawn failure (FR-021 no retry)", () => {
  it("releases the in-flight slot and drops the entry on spawn failure", async () => {
    const entry = makeEntry();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });
    mockSpawnIsolatedJob.mockImplementation(() => Promise.reject(new Error("k8s API unreachable")));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    await drainPendingOnce(app);

    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
    expect(mockReleaseInFlight).toHaveBeenCalledTimes(1);
    expect(mockReleaseInFlight.mock.calls[0]?.[0]).toBe(entry.deliveryId);
  });

  it("posts an infra-absent rejection comment when the drained spawn trips infra-absent (Copilot PR #21)", async () => {
    // Import the mocked JobSpawnerError so `instanceof` matches the class
    // the drainer sees after module mocking resolves.
    const { JobSpawnerError } = await import("../../src/k8s/job-spawner");

    const entry = makeEntry();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });
    mockSpawnIsolatedJob.mockImplementation(() =>
      Promise.reject(
        new (JobSpawnerError as unknown as new (k: string, m: string) => Error)(
          "infra-absent",
          "k8s removed",
        ),
      ),
    );

    // Upgrade app.getInstallationOctokit so the reconstructed BotContext
    // has a real-looking `octokit.rest.issues.createComment` — that's what
    // the new postInfraAbsentDrainRejection helper calls.
    const createComment = mock(() => Promise.resolve({ data: { id: 77 } }));
    const app = makeApp();
    app.getInstallationOctokit = mock(() =>
      Promise.resolve({
        rest: { issues: { createComment } },
      } as unknown),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await drainPendingOnce(app as any);

    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
    expect(mockReleaseInFlight).toHaveBeenCalledTimes(1);
    // The key assertion: drainer surfaced infra-absent to the user instead
    // of silently dropping.
    expect(createComment).toHaveBeenCalledTimes(1);
    const callArgs = (createComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    if (callArgs !== undefined) {
      const [arg] = callArgs as [{ body: string }];
      expect(arg.body.toLowerCase()).toContain("kubernetes");
      expect(arg.body.toLowerCase()).toContain("no longer reachable");
    }
  });

  it("does NOT post an infra-absent comment for non-infra-absent spawn failures", async () => {
    const entry = makeEntry();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });
    mockSpawnIsolatedJob.mockImplementation(() =>
      Promise.reject(new Error("500 Internal Server Error")),
    );

    const createComment = mock(() => Promise.resolve({ data: { id: 1 } }));
    const app = makeApp();
    app.getInstallationOctokit = mock(() =>
      Promise.resolve({
        rest: { issues: { createComment } },
      } as unknown),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await drainPendingOnce(app as any);

    expect(createComment).not.toHaveBeenCalled();
    expect(mockReleaseInFlight).toHaveBeenCalledTimes(1);
  });
});

describe("drainPendingOnce — overlap guard", () => {
  it("two concurrent calls share one tick (single inFlightCount sequence)", async () => {
    // Make dequeue slow so the second call arrives while the first is
    // still in the tick; both should await the same promise.
    let resolved = false;
    const slowDequeue = (): Promise<DequeueResult> =>
      new Promise((resolve) => {
        const done = (): void => {
          resolved = true;
          resolve({ outcome: "empty" } as DequeueResult);
        };
        setTimeout(done, 25);
      });
    mockDequeuePending.mockImplementation(slowDequeue);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = makeApp() as any;
    const p1 = drainPendingOnce(app);
    const p2 = drainPendingOnce(app);
    await Promise.all([p1, p2]);

    expect(resolved).toBe(true);
    // Only one tick happened: inFlightCount called once, dequeuePending once.
    expect(mockInFlightCount).toHaveBeenCalledTimes(1);
    expect(mockDequeuePending).toHaveBeenCalledTimes(1);
  });
});

describe("drainPendingOnce — context reconstruction", () => {
  it("mints a fresh installation octokit via app.getInstallationOctokit", async () => {
    const entry = makeEntry();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    const app = makeApp();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await drainPendingOnce(app as any);

    expect(app.octokit.rest.apps.getRepoInstallation).toHaveBeenCalledTimes(1);
    expect(app.getInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(app.getInstallationOctokit.mock.calls[0]?.[0]).toBe(123);
  });

  it("drops the entry when installation resolution fails", async () => {
    const entry = makeEntry();
    let calls = 0;
    mockDequeuePending.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          outcome: "dequeued",
          entry,
          context: makeContext(),
        } as DequeueResult);
      }
      return Promise.resolve({ outcome: "empty" } as DequeueResult);
    });

    const app = makeApp();
    app.octokit.rest.apps.getRepoInstallation = mock(() =>
      Promise.reject(new Error("installation not found")),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await drainPendingOnce(app as any);

    expect(mockSpawnIsolatedJob).not.toHaveBeenCalled();
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
  });
});
