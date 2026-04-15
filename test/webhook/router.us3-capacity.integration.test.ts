/**
 * T042 (US3): integration-level coverage of the isolated-job capacity
 * back-pressure flow. Ties together the router dispatch gate, the
 * pending-queue mocks, the spawn side-effect, and the completion-watcher
 * wiring.
 *
 * Scenarios asserted (spec.md §US3 acceptance):
 *   1. Under capacity           → direct spawn + register slot + fire watcher.
 *   2. At capacity, queue room  → enqueue + "Queued" comment + no spawn.
 *   3. Queue full               → capacity-rejected row + rejection comment.
 *
 * Scenario 4 (wall-clock timeout, FR-021 no retry) is covered directly
 * against `watchJobCompletion` in `test/k8s/job-spawner.watch.test.ts` —
 * the watcher is pure except for K8s / Valkey / DB, so a unit-level test
 * with injected fakes is more precise than reaching through the router.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import type { BotContext } from "../../src/types";

// ---------------------------------------------------------------------------
// Module-level mocks (all external collaborators)
// ---------------------------------------------------------------------------

type EnqueueOutcome =
  | { readonly outcome: "enqueued"; readonly position: number }
  | { readonly outcome: "rejected-full"; readonly currentLength: number };

const mockInFlightCount = mock(() => Promise.resolve(0));
const mockEnqueuePending = mock(
  (): Promise<EnqueueOutcome> => Promise.resolve({ outcome: "enqueued", position: 1 }),
);
const mockRegisterInFlight = mock(() => Promise.resolve(1));
const mockReleaseInFlight = mock(() => Promise.resolve());

void mock.module("../../src/k8s/pending-queue", () => ({
  inFlightCount: mockInFlightCount,
  enqueuePending: mockEnqueuePending,
  registerInFlight: mockRegisterInFlight,
  releaseInFlight: mockReleaseInFlight,
  dequeuePending: mock(() => Promise.resolve({ outcome: "empty" as const })),
  pendingLength: mock(() => Promise.resolve(0)),
  getPosition: mock(() => Promise.resolve(null)),
  storeBotContext: mock(() => Promise.resolve()),
  loadBotContext: mock(() => Promise.resolve(null)),
  deleteBotContext: mock(() => Promise.resolve()),
  PENDING_LIST_KEY: "dispatch:isolated-job:pending",
  IN_FLIGHT_SET_KEY: "dispatch:isolated-job:in-flight",
  BOT_CONTEXT_TTL_SECONDS: 3600,
}));

const mockSpawnIsolatedJob = mock(() => Promise.resolve({ success: true, durationMs: 0 }));
const mockWatchJobCompletion = mock(() => Promise.resolve("succeeded" as const));

void mock.module("../../src/k8s/job-spawner", () => ({
  spawnIsolatedJob: mockSpawnIsolatedJob,
  watchJobCompletion: mockWatchJobCompletion,
  jobNameForDelivery: (d: string): string => `bot-${d}`,
  JobSpawnerError: class JobSpawnerError extends Error {
    constructor(
      readonly kind: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const mockCreateExecution = mock(() => Promise.resolve("exec-id"));
void mock.module("../../src/orchestrator/history", () => ({
  createExecution: mockCreateExecution,
  markExecutionFailed: mock(() => Promise.resolve()),
  markExecutionOffered: mock(() => Promise.resolve()),
  markExecutionRunning: mock(() => Promise.resolve()),
  markExecutionCompleted: mock(() => Promise.resolve()),
  requeueExecution: mock(() => Promise.resolve()),
  getExecutionState: mock(() => Promise.resolve(null)),
  getOrphanedExecutions: mock(() => Promise.resolve([])),
  recoverStaleExecutions: mock(() => Promise.resolve()),
}));

const mockGetDb = mock(() => null as unknown);
void mock.module("../../src/db", () => ({
  getDb: mockGetDb,
}));

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
      child: mock(() => ({}) as never),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

const { dispatch } = await import("../../src/webhook/router");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const silentLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock((): typeof silentLog => silentLog),
} as unknown as BotContext["log"];

let counter = 0;

function makeCtx(opts: { createComment?: ReturnType<typeof mock> } = {}): BotContext {
  counter++;
  const deliveryId = `del-${counter}`;
  const createComment =
    opts.createComment ?? mock(() => Promise.resolve({ data: { id: 1000 + counter } }));
  return {
    owner: "acme",
    repo: "widgets",
    entityNumber: counter,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "alice",
    triggerTimestamp: "2026-04-15T00:00:00Z",
    triggerBody: "@chrisleekr-bot help",
    commentId: counter,
    deliveryId,
    defaultBranch: "main",
    octokit: {
      auth: mock(() => Promise.resolve({ token: "ghs_test" })),
      rest: {
        issues: {
          listComments: mock(() => Promise.resolve({ data: [] })),
          createComment,
          getComment: mock(() => Promise.resolve({ data: { body: "Working..." } })),
          updateComment: mock(() => Promise.resolve({ data: { id: 1 } })),
        },
      },
    } as unknown as Octokit,
    log: silentLog,
  } as BotContext;
}

const decision = {
  target: "isolated-job" as const,
  reason: "label" as const,
  maxTurns: 30,
};

beforeEach(() => {
  mockInFlightCount.mockClear();
  mockEnqueuePending.mockClear();
  mockRegisterInFlight.mockClear();
  mockReleaseInFlight.mockClear();
  mockSpawnIsolatedJob.mockClear();
  mockWatchJobCompletion.mockClear();
  mockCreateExecution.mockClear();
  mockGetDb.mockClear();
  mockGetDb.mockImplementation(() => ({}) as unknown);
  mockInFlightCount.mockImplementation(() => Promise.resolve(0));
  mockEnqueuePending.mockImplementation(
    (): Promise<EnqueueOutcome> => Promise.resolve({ outcome: "enqueued", position: 1 }),
  );
  mockSpawnIsolatedJob.mockImplementation(() => Promise.resolve({ success: true, durationMs: 0 }));
  mockWatchJobCompletion.mockImplementation(() => Promise.resolve("succeeded" as const));
});

afterEach(() => {
  mockGetDb.mockImplementation(() => null as unknown);
});

// ---------------------------------------------------------------------------
// Scenario 1 — under capacity
// ---------------------------------------------------------------------------

describe("US3 Scenario 1 — under capacity", () => {
  it("spawns directly, registers the slot, and fires the completion watcher", async () => {
    mockInFlightCount.mockImplementation(() => Promise.resolve(1));
    const ctx = makeCtx();

    await dispatch(ctx, decision);

    expect(mockInFlightCount).toHaveBeenCalledTimes(1);
    expect(mockSpawnIsolatedJob).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).toHaveBeenCalledWith(ctx.deliveryId);
    expect(mockWatchJobCompletion).toHaveBeenCalledTimes(1);
    const watchCall = mockWatchJobCompletion.mock.calls[0] as unknown as [string];
    expect(watchCall[0]).toBe(ctx.deliveryId);
    expect(mockEnqueuePending).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — at capacity, queue has room
// ---------------------------------------------------------------------------

describe("US3 Scenario 2 — at capacity, queue has room", () => {
  it("enqueues, posts a 'Queued' comment, does NOT spawn, does NOT fire watcher", async () => {
    mockInFlightCount.mockImplementation(() => Promise.resolve(3));
    mockEnqueuePending.mockImplementation(
      (): Promise<EnqueueOutcome> => Promise.resolve({ outcome: "enqueued", position: 4 }),
    );
    const createComment = mock(() => Promise.resolve({ data: { id: 777 } }));
    const ctx = makeCtx({ createComment });

    await dispatch(ctx, decision);

    expect(mockEnqueuePending).toHaveBeenCalledTimes(1);
    expect(mockSpawnIsolatedJob).not.toHaveBeenCalled();
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
    expect(mockWatchJobCompletion).not.toHaveBeenCalled();

    expect(createComment).toHaveBeenCalled();
    const call = createComment.mock.calls[0] as unknown as [{ body: string }];
    const body = call[0].body;
    expect(body).toContain("\u23F3 Queued"); // ⏳
    expect(body).toContain("position 4");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — queue full (FR-018 no downgrade)
// ---------------------------------------------------------------------------

describe("US3 Scenario 3 — queue full", () => {
  it("writes capacity-rejected execution row, posts rejection comment, never downgrades", async () => {
    mockInFlightCount.mockImplementation(() => Promise.resolve(3));
    mockEnqueuePending.mockImplementation(
      (): Promise<EnqueueOutcome> =>
        Promise.resolve({ outcome: "rejected-full", currentLength: 20 }),
    );
    const createComment = mock(() => Promise.resolve({ data: { id: 888 } }));
    const ctx = makeCtx({ createComment });

    await dispatch(ctx, decision);

    expect(mockSpawnIsolatedJob).not.toHaveBeenCalled();
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
    expect(mockWatchJobCompletion).not.toHaveBeenCalled();

    expect(mockCreateExecution).toHaveBeenCalled();
    const execCall = mockCreateExecution.mock.calls[0] as unknown as [
      { dispatchMode: string; dispatchReason: string },
    ];
    expect(execCall[0].dispatchMode).toBe("isolated-job");
    expect(execCall[0].dispatchReason).toBe("capacity-rejected");

    const rejectionCall = createComment.mock.calls[0] as unknown as [{ body: string }];
    expect(rejectionCall[0].body.toLowerCase()).toContain("pool is at capacity");
    expect(rejectionCall[0].body.toLowerCase()).toContain("will not silently downgrade");
  });
});
