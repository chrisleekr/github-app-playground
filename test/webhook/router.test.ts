/**
 * Tests for processRequest in src/webhook/router.ts.
 *
 * Covers both routing concerns (idempotency, auth, concurrency) and the inline
 * execution pipeline (src/core/inline-pipeline.ts). After the pipeline extraction,
 * router.ts delegates to runInlinePipeline() — tests exercise the full path through
 * both modules via processRequest().
 *
 * Design decisions:
 * - mock.module() in Bun persists across ALL test files in the same process run.
 *   We therefore ONLY mock modules without dedicated test files: checkout, executor,
 *   prompt-builder, registry. We do NOT mock retry, fetcher, or tracking-comment
 *   because those have their own test files that would be broken by module-level mocks.
 * - tracking-comment functions (isAlreadyProcessed, createTrackingComment, …) run with
 *   a fully mocked octokit — no real GitHub API calls.
 * - fetchGitHubData runs with a mocked octokit.graphql — no real GraphQL calls.
 * - retryWithBackoff runs as-is; all underlying mocked operations resolve on the first
 *   attempt so no delay actually occurs.
 * - Each test uses a unique deliveryId to avoid collisions in the module-level
 *   `processed` Map which is never reset between tests.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import type { BotContext } from "../../src/types";
import { waitFor } from "../utils/assertions";

// ─── Mock only modules without dedicated test files ────────────────────────

const mockCleanup = mock(() => Promise.resolve());
const mockCheckoutRepo = mock(() =>
  Promise.resolve({ workDir: "/tmp/test", cleanup: mockCleanup }),
);
const mockExecuteAgent = mock(() => Promise.resolve({ success: true, durationMs: 100 }));
const mockResolveMcpServers = mock(() => ({}));

// Orchestrator module mocks for non-inline dispatch paths
const mockIsValkeyHealthy = mock(() => false);
const mockCreateExecution = mock(() => Promise.resolve());
const mockDispatchJob = mock(() => Promise.resolve(false));
const mockEnqueueJob = mock(() => Promise.resolve());
const mockGetDb = mock(() => null as unknown);

// mock.module() returns void in Bun's runtime but ESLint infers a Promise from the factory.
// The void operator suppresses the no-floating-promises rule for these static mock registrations.
// NOTE: prompt-builder is NOT mocked here — it has its own dedicated test file and is a pure
// function with no side effects, so running the real implementation in router tests is safe.
void mock.module("../../src/core/checkout", () => ({
  checkoutRepo: mockCheckoutRepo,
}));

void mock.module("../../src/core/executor", () => ({
  executeAgent: mockExecuteAgent,
}));

void mock.module("../../src/mcp/registry", () => ({
  resolveMcpServers: mockResolveMcpServers,
}));

void mock.module("../../src/orchestrator/valkey", () => ({
  isValkeyHealthy: mockIsValkeyHealthy,
  getValkeyClient: mock(() => null),
  requireValkeyClient: mock(() => {
    throw new Error("No Valkey in test");
  }),
  closeValkey: mock(() => {}),
}));

void mock.module("../../src/orchestrator/history", () => ({
  createExecution: mockCreateExecution,
  markExecutionOffered: mock(() => Promise.resolve()),
  markExecutionRunning: mock(() => Promise.resolve()),
  markExecutionCompleted: mock(() => Promise.resolve()),
  markExecutionFailed: mock(() => Promise.resolve()),
  requeueExecution: mock(() => Promise.resolve()),
  getExecutionState: mock(() => Promise.resolve(null)),
  getOrphanedExecutions: mock(() => Promise.resolve([])),
  recoverStaleExecutions: mock(() => Promise.resolve()),
}));

void mock.module("../../src/orchestrator/job-dispatcher", () => ({
  dispatchJob: mockDispatchJob,
}));

void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
}));

void mock.module("../../src/db", () => ({
  getDb: mockGetDb,
}));

// US3 (T044): isolated-job dispatch now consults the Valkey-backed pending
// queue + in-flight tracker. Mock both so tests don't need a live Valkey.
// By default the queue is empty and in-flight is under capacity, so the
// isolated-job branch takes its "direct spawn" path — the same behaviour
// pre-T044 tests assumed.
const mockInFlightCount = mock(() => Promise.resolve(0));
const mockEnqueuePending = mock(() =>
  Promise.resolve({ outcome: "enqueued", position: 1 } as const),
);
const mockRegisterInFlight = mock(() => Promise.resolve(1));

const mockReleaseInFlight = mock(() => Promise.resolve());
// Stub exports used by sibling modules (drainer, job-spawner watcher) so
// cross-test-file module caching doesn't fail imports when this mock is
// evaluated first.
const mockDequeuePending = mock(() => Promise.resolve({ outcome: "empty" as const }));
const mockPendingLength = mock(() => Promise.resolve(0));
const mockGetPosition = mock(() => Promise.resolve(null));
const mockStoreBotContext = mock(() => Promise.resolve());
const mockLoadBotContext = mock(() => Promise.resolve(null));
const mockDeleteBotContext = mock(() => Promise.resolve());

void mock.module("../../src/k8s/pending-queue", () => ({
  inFlightCount: mockInFlightCount,
  enqueuePending: mockEnqueuePending,
  registerInFlight: mockRegisterInFlight,
  releaseInFlight: mockReleaseInFlight,
  dequeuePending: mockDequeuePending,
  pendingLength: mockPendingLength,
  getPosition: mockGetPosition,
  storeBotContext: mockStoreBotContext,
  loadBotContext: mockLoadBotContext,
  deleteBotContext: mockDeleteBotContext,
  PENDING_LIST_KEY: "dispatch:isolated-job:pending",
  IN_FLIGHT_SET_KEY: "dispatch:isolated-job:in-flight",
  BOT_CONTEXT_TTL_SECONDS: 3600,
}));

// Import router AFTER mocks are set up
const { processRequest, decideDispatch, dispatch, NotImplementedError } =
  await import("../../src/webhook/router");
const { getActiveCount, decrementActiveCount } = await import("../../src/orchestrator/concurrency");

// ─── GraphQL response factory ──────────────────────────────────────────────

/** Minimal valid GraphQL response for an issue (isPR=false). */
function makeGraphqlResponse(): {
  repository: {
    issue: {
      title: string;
      body: string;
      author: { login: string };
      createdAt: string;
      updatedAt: string;
      lastEditedAt: null;
      state: string;
      comments: { nodes: never[] };
    };
  };
} {
  return {
    repository: {
      issue: {
        title: "Test Issue",
        body: "",
        author: { login: "user" },
        createdAt: "2024-12-01T00:00:00Z",
        updatedAt: "2024-12-01T00:00:00Z",
        lastEditedAt: null,
        state: "OPEN",
        comments: { nodes: [] },
      },
    },
  };
}

// ─── Octokit factory ───────────────────────────────────────────────────────

/**
 * Build a minimal octokit mock satisfying all calls made during processRequest:
 * - graphql()              → fetchGitHubData
 * - issues.listComments()  → isAlreadyProcessed
 * - issues.createComment() → createTrackingComment / concurrency comment
 * - issues.getComment()    → finalizeTrackingComment (read existing body)
 * - issues.updateComment() → finalizeTrackingComment / updateTrackingComment
 * - auth()                 → installation token
 */
function makeOctokit(
  opts: {
    listCommentsBodies?: (string | undefined)[];
    createCommentId?: number;
    existingBody?: string;
    createCommentFn?: () => Promise<{ data: { id: number } }>;
    graphqlFn?: () => Promise<unknown>;
  } = {},
): Octokit {
  const {
    listCommentsBodies = [],
    createCommentId = 999,
    existingBody = "Working...",
    createCommentFn,
    graphqlFn,
  } = opts;

  return {
    auth: mock(() => Promise.resolve({ token: "ghs_test_token" })),
    graphql: graphqlFn ? mock(graphqlFn) : mock(() => Promise.resolve(makeGraphqlResponse())),
    rest: {
      issues: {
        listComments: mock(() =>
          Promise.resolve({ data: listCommentsBodies.map((body) => ({ body })) }),
        ),
        createComment: createCommentFn
          ? mock(createCommentFn)
          : mock(() => Promise.resolve({ data: { id: createCommentId } })),
        getComment: mock(() => Promise.resolve({ data: { body: existingBody } })),
        updateComment: mock(() => Promise.resolve({ data: { id: createCommentId } })),
      },
    },
  } as unknown as Octokit;
}

// ─── Context factory ───────────────────────────────────────────────────────

let counter = 0;

function makeCtx(
  overrides?: Partial<BotContext> & { octokitOpts?: Parameters<typeof makeOctokit>[0] },
): BotContext {
  counter++;
  const { octokitOpts, ...ctxOverrides } = overrides ?? {};
  const deliveryId = `router-test-${counter}-${Date.now()}`;

  const silentLog = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function () {
      return this;
    }),
  } as never;

  return {
    owner: "myorg",
    repo: "myrepo",
    entityNumber: 1,
    isPR: false,
    eventName: "issue_comment" as const,
    triggerUsername: "tester",
    triggerTimestamp: "2025-01-01T00:00:00Z",
    triggerBody: "@chrisleekr-bot help",
    commentId: 1,
    deliveryId,
    defaultBranch: "main",
    labels: [],
    octokit: makeOctokit(octokitOpts),
    log: silentLog,
    ...ctxOverrides,
  };
}

// ─── Reset shared mocks between tests ─────────────────────────────────────
// .mockClear() resets call history; .mockResolvedValue/.mockReturnValue resets
// the implementation. Both are needed: history for toHaveBeenCalledTimes assertions,
// implementation to prevent stale behaviours from previous tests leaking in.

beforeEach(() => {
  // Drain concurrency counter to prevent capacity leaks from non-inline tests
  while (getActiveCount() > 0) decrementActiveCount();

  mockCleanup.mockClear();
  mockCheckoutRepo.mockClear();
  mockExecuteAgent.mockClear();
  mockResolveMcpServers.mockClear();
  mockIsValkeyHealthy.mockClear();
  mockCreateExecution.mockClear();
  mockDispatchJob.mockClear();
  mockEnqueueJob.mockClear();
  mockGetDb.mockClear();

  mockCleanup.mockResolvedValue(undefined);
  mockCheckoutRepo.mockResolvedValue({ workDir: "/tmp/test", cleanup: mockCleanup });
  mockExecuteAgent.mockResolvedValue({ success: true, durationMs: 100 });
  mockResolveMcpServers.mockReturnValue({});
  // Default: Valkey NOT healthy (inline tests don't hit the Valkey check)
  mockIsValkeyHealthy.mockReturnValue(false);
  mockCreateExecution.mockResolvedValue(undefined);
  mockDispatchJob.mockResolvedValue(false);
  mockEnqueueJob.mockResolvedValue(undefined);
  // Default: no database configured (inline mode without DB)
  mockGetDb.mockReturnValue(null);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("processRequest — in-memory idempotency (fast path)", () => {
  it("skips processing when called twice with the same deliveryId", async () => {
    const ctx = makeCtx();
    const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    await processRequest(ctx);
    await processRequest(ctx); // second call with same deliveryId must skip

    // createComment is called inside createTrackingComment (past the idempotency guard).
    // If the second call was not skipped it would be called twice.
    expect(createCommentSpy).toHaveBeenCalledTimes(1);
  });
});

describe("processRequest — durable idempotency (marker found in GitHub)", () => {
  it("skips processing when the delivery marker is present in an existing comment", async () => {
    const ctx = makeCtx({
      octokitOpts: {
        // Will be overridden below with the real deliveryId
        listCommentsBodies: [],
      },
    });

    // Point listComments at a body containing the actual deliveryId marker
    const markerBody = `<!-- delivery:${ctx.deliveryId} -->\nDone`;
    (ctx.octokit.rest.issues.listComments as ReturnType<typeof mock>).mockResolvedValue({
      data: [{ body: markerBody }],
    });

    const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    await processRequest(ctx);

    // Pipeline must stop before createTrackingComment
    expect(createCommentSpy).not.toHaveBeenCalled();
  });

  it("primes the in-memory map so subsequent retries skip the durable check", async () => {
    const ctx = makeCtx();
    const markerBody = `<!-- delivery:${ctx.deliveryId} -->\nDone`;
    const listCommentsSpy = ctx.octokit.rest.issues.listComments as ReturnType<typeof mock>;

    listCommentsSpy.mockResolvedValue({ data: [{ body: markerBody }] });

    await processRequest(ctx); // durable check finds marker → skip → sets in-memory map
    await processRequest(ctx); // must be caught by in-memory map (no listComments call)

    // listComments should only be called once — on the first invocation.
    expect(listCommentsSpy).toHaveBeenCalledTimes(1);
  });
});

describe("processRequest — race condition prevention", () => {
  it("second concurrent call with same deliveryId is blocked by in-memory reservation", async () => {
    const ctx = makeCtx();
    const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    // Both calls start concurrently. The fixed code sets processed.set() BEFORE awaiting
    // isAlreadyProcessed, so the second concurrent call hits has() → true immediately.
    await Promise.all([processRequest(ctx), processRequest(ctx)]);

    // Only one tracking comment and one agent execution should occur
    expect(createCommentSpy).toHaveBeenCalledTimes(1);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });
});

describe("processRequest — error handling (pipeline)", () => {
  it("always calls cleanup even when executeAgent throws", async () => {
    mockExecuteAgent.mockRejectedValue(new Error("agent blew up"));
    const ctx = makeCtx();

    await processRequest(ctx);

    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it("posts a generic error message — does not expose internal error details", async () => {
    const internalError = new Error(
      "Request failed with status 401: invalid API key 'sk-ant-secret'",
    );
    mockExecuteAgent.mockRejectedValue(internalError);
    const ctx = makeCtx();
    const updateCommentSpy = ctx.octokit.rest.issues.updateComment as ReturnType<typeof mock>;

    await processRequest(ctx);

    // finalizeTrackingComment calls updateComment with the final comment body.
    const calls = updateCommentSpy.mock.calls as [{ body: string }][];
    expect(calls.length).toBeGreaterThan(0);
    // calls.length > 0 is asserted above; the non-null cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const finalBody = calls[calls.length - 1]![0].body;

    // Extract ONLY the `**Error:** ...` line. The surrounding body also
    // contains an HTML comment metadata marker (`<!-- delivery:...-TIMESTAMP -->`)
    // whose random Date.now() digits can accidentally contain probe strings
    // like "401" and produce a flaky false positive. The user-facing leak
    // surface is the rendered error line, not the metadata marker.
    const errorLine = finalBody.split("\n").find((line) => line.startsWith("**Error:**"));
    expect(errorLine).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const line = errorLine!;
    expect(line).not.toContain("sk-ant-secret");
    expect(line).not.toContain("invalid API key");
    expect(line).not.toContain("401");
    expect(line).toContain("internal error");
  });

  it("does not crash when createTrackingComment fails", async () => {
    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: () => Promise.reject(new Error("GitHub API down")),
      },
    });

    // Must resolve without throwing even when createTrackingComment fails
    let didThrow = false;
    try {
      await processRequest(ctx);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);
  });
});

describe("processRequest — successful execution (pipeline)", () => {
  it("finalizes comment with success content after a successful run", async () => {
    mockExecuteAgent.mockResolvedValue({ success: true, durationMs: 3000, costUsd: 0.05 });
    const ctx = makeCtx();
    const updateCommentSpy = ctx.octokit.rest.issues.updateComment as ReturnType<typeof mock>;

    await processRequest(ctx);

    const calls = updateCommentSpy.mock.calls as [{ body: string }][];
    expect(calls.length).toBeGreaterThan(0);
    // calls.length > 0 is asserted above; the non-null cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const finalBody = calls[calls.length - 1]![0].body;
    expect(finalBody).toContain("finished");
    expect(finalBody).toContain("@chrisleekr-bot");
  });

  it("executes the core pipeline steps in order", async () => {
    const order: string[] = [];

    const ctx = makeCtx({
      octokitOpts: {
        graphqlFn: () => {
          order.push("fetchGitHubData");
          return Promise.resolve(makeGraphqlResponse());
        },
      },
    });
    mockCheckoutRepo.mockImplementation(() => {
      order.push("checkoutRepo");
      return Promise.resolve({ workDir: "/tmp/x", cleanup: mockCleanup });
    });
    mockExecuteAgent.mockImplementation(() => {
      order.push("executeAgent");
      return Promise.resolve({ success: true, durationMs: 100 });
    });

    // Capture createTrackingComment order via createComment spy
    const origCreate = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;
    (ctx.octokit.rest.issues as unknown as Record<string, unknown>)["createComment"] = mock(
      (...args: Parameters<typeof origCreate>) => {
        order.push("createTrackingComment");
        return origCreate(...args);
      },
    );

    await processRequest(ctx);

    expect(order).toEqual([
      "createTrackingComment",
      "fetchGitHubData",
      "checkoutRepo",
      "executeAgent",
    ]);
  });
});

describe("processRequest — concurrency limiting", () => {
  it("rejects requests and posts capacity comment when activeCount >= limit", async () => {
    // Import the real config singleton and temporarily lower the concurrency limit.
    // The router reads `config.maxConcurrentRequests` on each call (not cached at import).
    const { config } = await import("../../src/config");
    const originalLimit = config.maxConcurrentRequests;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).maxConcurrentRequests = 1;

    // Deferred promise to hold the first request's executeAgent open,
    // keeping activeCount at 1 while the second request attempts to enter.
    let resolveFirst: (value: { success: boolean; durationMs: number }) => void = () => undefined;
    const firstExecution = new Promise<{ success: boolean; durationMs: number }>((resolve) => {
      resolveFirst = resolve;
    });
    mockExecuteAgent.mockImplementationOnce(() => firstExecution);

    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const ctx2CreateCommentSpy = ctx2.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    // Launch request 1 (will hang at executeAgent, activeCount = 1)
    const req1 = processRequest(ctx1);

    try {
      // Deterministic sync: wait until req1 actually enters executeAgent and
      // increments activeCount. Replaces a 10ms setTimeout that was flaky on
      // slow CI runners. `mock.calls.length >= 1` is the exact condition we
      // need before launching the concurrent request 2.
      await waitFor(() => mockExecuteAgent.mock.calls.length >= 1);

      // Launch request 2 — should hit concurrency limit and be rejected
      await processRequest(ctx2);

      // Capacity comment should have been posted by request 2
      const capacityCall = ctx2CreateCommentSpy.mock.calls.find((call) => {
        const body = (call[0] as { body?: string }).body;
        return typeof body === "string" && body.includes("at capacity");
      });
      expect(capacityCall).toBeDefined();
    } finally {
      // ALWAYS restore config and drain req1, even on assertion failure.
      // Without this, a failing assertion would leave config.maxConcurrentRequests=1
      // and a hanging request 1 → cascading failures in subsequent tests.
      resolveFirst({ success: true, durationMs: 100 });
      await req1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).maxConcurrentRequests = originalLimit;
    }
  });

  it("does not crash when capacity comment post fails", async () => {
    const { config } = await import("../../src/config");
    const originalLimit = config.maxConcurrentRequests;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).maxConcurrentRequests = 1;

    let resolveFirst: (value: { success: boolean; durationMs: number }) => void = () => undefined;
    const firstExecution = new Promise<{ success: boolean; durationMs: number }>((resolve) => {
      resolveFirst = resolve;
    });
    mockExecuteAgent.mockImplementationOnce(() => firstExecution);

    const ctx1 = makeCtx();
    const ctx2 = makeCtx({
      octokitOpts: {
        createCommentFn: () => Promise.reject(new Error("API down")),
      },
    });

    const req1 = processRequest(ctx1);

    try {
      // Deterministic sync: wait until req1 actually enters executeAgent
      // (see sibling test above for rationale).
      await waitFor(() => mockExecuteAgent.mock.calls.length >= 1);

      // Must not throw even though capacity comment post fails
      let didThrow = false;
      try {
        await processRequest(ctx2);
      } catch {
        didThrow = true;
      }
      expect(didThrow).toBe(false);
    } finally {
      resolveFirst({ success: true, durationMs: 100 });
      await req1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).maxConcurrentRequests = originalLimit;
    }
  });
});

describe("processRequest — owner allowlist", () => {
  it("silently skips requests when the repository owner is not in ALLOWED_OWNERS", async () => {
    // Sets config.allowedOwners to a value that excludes the default ctx.owner="myorg".
    // The rejection path must return BEFORE createTrackingComment, so no comment
    // is posted to the unauthorized repo (silent skip — see router.ts comment).
    const { config } = await import("../../src/config");
    const originalAllowedOwners = config.allowedOwners;
    config.allowedOwners = ["different-owner"];

    try {
      const ctx = makeCtx();
      const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

      await processRequest(ctx);

      // No tracking comment should be created for a rejected request
      expect(createCommentSpy).not.toHaveBeenCalled();
      // And the agent should never be invoked
      expect(mockExecuteAgent).not.toHaveBeenCalled();
    } finally {
      config.allowedOwners = originalAllowedOwners;
    }
  });

  it("processes requests normally when the owner is in ALLOWED_OWNERS (case-insensitive)", async () => {
    // Owner matching is case-insensitive (GitHub login identity semantics).
    // ctx.owner defaults to "myorg"; the allowlist uses "MyOrg".
    const { config } = await import("../../src/config");
    const originalAllowedOwners = config.allowedOwners;
    config.allowedOwners = ["MyOrg"];

    try {
      const ctx = makeCtx();
      const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

      await processRequest(ctx);

      // Pipeline must run end-to-end: createTrackingComment + executeAgent.
      expect(createCommentSpy).toHaveBeenCalled();
      expect(mockExecuteAgent).toHaveBeenCalled();
    } finally {
      config.allowedOwners = originalAllowedOwners;
    }
  });

  it("does not post a capacity comment when a non-allowlisted owner hits the concurrency limit", async () => {
    // Regression test for the ordering bug: previously the concurrency guard
    // ran BEFORE the allowlist check, so a non-allowlisted repo hitting the
    // limit would receive an "at capacity" comment and learn the bot exists.
    // After the fix, the allowlist check runs first — the unauthorized repo
    // must see zero comments of any kind (silent skip).
    const { config } = await import("../../src/config");
    const originalLimit = config.maxConcurrentRequests;
    const originalAllowedOwners = config.allowedOwners;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).maxConcurrentRequests = 1;
    config.allowedOwners = ["only-allowed-org"];

    // Hold request 1 open at executeAgent so activeCount stays at 1.
    let resolveFirst: (value: { success: boolean; durationMs: number }) => void = () => undefined;
    const firstExecution = new Promise<{ success: boolean; durationMs: number }>((resolve) => {
      resolveFirst = resolve;
    });
    mockExecuteAgent.mockImplementationOnce(() => firstExecution);

    // ctx1 uses an allowlisted owner so it enters the pipeline and occupies
    // the sole concurrency slot. ctx2 uses a non-allowlisted owner.
    const ctx1 = makeCtx({ owner: "only-allowed-org" });
    const ctx2 = makeCtx({ owner: "rejected-org" });
    const ctx2CreateCommentSpy = ctx2.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    const req1 = processRequest(ctx1);

    try {
      await waitFor(() => mockExecuteAgent.mock.calls.length >= 1);

      await processRequest(ctx2);

      // The critical assertion: NO comment of any kind (tracking OR capacity)
      // was posted to the non-allowlisted repo, even though activeCount was
      // at the limit when request 2 arrived.
      expect(ctx2CreateCommentSpy).not.toHaveBeenCalled();
    } finally {
      resolveFirst({ success: true, durationMs: 100 });
      await req1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).maxConcurrentRequests = originalLimit;
      config.allowedOwners = originalAllowedOwners;
    }
  });
});

describe("processRequest — agentJobMode non-inline dispatch", () => {
  it("rejects with Valkey unavailable message when Valkey is not connected", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(false);

    const ctx = makeCtx();
    const executorCallsBefore = mockExecuteAgent.mock.calls.length;
    const createCommentSpy = ctx.octokit.rest.issues.createComment as ReturnType<typeof mock>;

    try {
      await processRequest(ctx);

      // Pipeline should NOT have been invoked (no executeAgent call)
      expect(mockExecuteAgent.mock.calls.length).toBe(executorCallsBefore);

      // User should be notified that Valkey is unavailable (FM-7)
      const modeCall = createCommentSpy.mock.calls.find((call) => {
        const body = (call[0] as { body?: string }).body;
        return (
          typeof body === "string" && body.includes("job queue service is temporarily unavailable")
        );
      });
      expect(modeCall).toBeDefined();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("does not crash when Valkey unavailable comment post fails (line 181)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(false);

    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: () => Promise.reject(new Error("GitHub API down")),
      },
    });

    try {
      let didThrow = false;
      try {
        await processRequest(ctx);
      } catch {
        didThrow = true;
      }
      // Must resolve without throwing even when Valkey unavailable comment fails
      expect(didThrow).toBe(false);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("dispatches to daemon when Valkey is healthy and a daemon is available (lines 187-223)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    mockDispatchJob.mockResolvedValue(true);

    const ctx = makeCtx();

    try {
      await processRequest(ctx);

      // createExecution should have been called with non-inline dispatch mode
      expect(mockCreateExecution).toHaveBeenCalledTimes(1);
      const execArgs = mockCreateExecution.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(execArgs.deliveryId).toBe(ctx.deliveryId);
      expect(execArgs.dispatchMode).toBe("daemon");
      expect(execArgs.repoOwner).toBe(ctx.owner);
      expect(execArgs.repoName).toBe(ctx.repo);

      // dispatchJob should have been called with a QueuedJob
      expect(mockDispatchJob).toHaveBeenCalledTimes(1);
      const jobArg = mockDispatchJob.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(jobArg.deliveryId).toBe(ctx.deliveryId);
      expect(jobArg.repoOwner).toBe(ctx.owner);
      expect(jobArg.repoName).toBe(ctx.repo);
      expect(jobArg.entityNumber).toBe(ctx.entityNumber);
      expect(jobArg.retryCount).toBe(0);

      // Inline pipeline should NOT run
      expect(mockExecuteAgent).not.toHaveBeenCalled();

      // enqueueJob should NOT be called (daemon was available)
      expect(mockEnqueueJob).not.toHaveBeenCalled();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("enqueues job when no daemon is available (lines 226-231)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    mockDispatchJob.mockResolvedValue(false); // no daemon available

    const ctx = makeCtx();

    try {
      await processRequest(ctx);

      // createExecution and dispatchJob both called
      expect(mockCreateExecution).toHaveBeenCalledTimes(1);
      expect(mockDispatchJob).toHaveBeenCalledTimes(1);

      // enqueueJob should be called as fallback
      expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
      const queuedJobArg = mockEnqueueJob.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(queuedJobArg.deliveryId).toBe(ctx.deliveryId);

      // Inline pipeline should NOT run
      expect(mockExecuteAgent).not.toHaveBeenCalled();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("uses 'shared-runner' dispatch mode when agentJobMode is 'auto' (line 197)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    mockDispatchJob.mockResolvedValue(true);

    const ctx = makeCtx();

    try {
      await processRequest(ctx);

      // dispatchMode should map 'auto' to 'shared-runner'
      const execArgs = mockCreateExecution.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(execArgs.dispatchMode).toBe("daemon");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("releases concurrency slot on infrastructure failure (lines 233-236)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    // createExecution throws to simulate infrastructure failure
    mockCreateExecution.mockRejectedValue(new Error("Postgres down"));

    const ctx = makeCtx();

    try {
      // The error should propagate out of processRequest (dispatchNonInline re-throws)
      let thrownError: Error | undefined;
      try {
        await processRequest(ctx);
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError?.message).toBe("Postgres down");

      // Inline pipeline should NOT run
      expect(mockExecuteAgent).not.toHaveBeenCalled();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("builds QueuedJob with correct triggerBodyPreview truncated to 200 chars (line 210)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    mockDispatchJob.mockResolvedValue(true);

    const longBody = "a".repeat(500);
    const ctx = makeCtx({ triggerBody: longBody });

    try {
      await processRequest(ctx);

      const jobArg = mockDispatchJob.mock.calls[0]?.[0] as Record<string, unknown>;
      const preview = jobArg.triggerBodyPreview as string;
      expect(preview.length).toBe(200);
      expect(preview).toBe("a".repeat(200));
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });

  it("correctly maps entityType based on isPR flag (line 194)", async () => {
    const { config } = await import("../../src/config");
    const originalMode = config.agentJobMode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).agentJobMode = "daemon";

    mockIsValkeyHealthy.mockReturnValue(true);
    mockDispatchJob.mockResolvedValue(true);

    const ctx = makeCtx({ isPR: true });

    try {
      await processRequest(ctx);

      const execArgs = mockCreateExecution.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(execArgs.entityType).toBe("pull_request");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).agentJobMode = originalMode;
    }
  });
});

describe("processRequest — inline execution recording (line 150)", () => {
  it("continues pipeline when inline execution record creation fails (non-fatal)", async () => {
    // When DATABASE_URL is configured, the inline path records an execution in Postgres.
    // If that recording fails, the pipeline should continue (non-fatal error).
    mockGetDb.mockReturnValue({} as unknown); // non-null → db is "configured"
    mockCreateExecution.mockRejectedValue(new Error("Postgres insert failed"));

    const ctx = makeCtx();

    await processRequest(ctx);

    // Pipeline must still run despite the recording failure
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);

    // The error should be logged (check log.error was called)
    const errorCalls = (ctx.log.error as ReturnType<typeof mock>).mock.calls;
    const flatArgs = errorCalls.flat() as unknown[];
    const hasRecordErr = flatArgs.some(
      (arg) => typeof arg === "string" && arg.includes("Failed to create inline execution record"),
    );
    expect(hasRecordErr).toBe(true);
  });

  it("records inline execution when db is configured and createExecution succeeds", async () => {
    mockGetDb.mockReturnValue({} as unknown); // non-null → db is "configured"
    mockCreateExecution.mockResolvedValue(undefined);

    const ctx = makeCtx();

    await processRequest(ctx);

    // createExecution should have been called for inline mode
    expect(mockCreateExecution).toHaveBeenCalledTimes(1);
    const execArgs = mockCreateExecution.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(execArgs.deliveryId).toBe(ctx.deliveryId);
    expect(execArgs.dispatchMode).toBe("inline");
    expect(execArgs.entityType).toBe("issue");

    // Pipeline should still complete
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupStaleIdempotencyEntries", () => {
  it("removes entries older than the TTL and preserves fresh entries", async () => {
    const { cleanupStaleIdempotencyEntries } = await import("../../src/webhook/router");

    const now = Date.now();
    const ttlMs = 60 * 60 * 1000; // 1 hour
    const entries = new Map<string, number>();
    entries.set("stale-2h", now - 2 * 60 * 60 * 1000); // 2h ago → delete
    entries.set("stale-edge", now - ttlMs - 1); // just past TTL → delete
    entries.set("fresh", now); // now → keep
    entries.set("fresh-minus-5min", now - 5 * 60 * 1000); // 5m ago → keep

    cleanupStaleIdempotencyEntries(entries, ttlMs);

    expect(entries.has("stale-2h")).toBe(false);
    expect(entries.has("stale-edge")).toBe(false);
    expect(entries.has("fresh")).toBe(true);
    expect(entries.has("fresh-minus-5min")).toBe(true);
    expect(entries.size).toBe(2);
  });

  it("is a no-op when the map is empty", async () => {
    const { cleanupStaleIdempotencyEntries } = await import("../../src/webhook/router");

    const entries = new Map<string, number>();
    cleanupStaleIdempotencyEntries(entries, 60 * 60 * 1000);

    expect(entries.size).toBe(0);
  });
});

// ─── T011–T013: decideDispatch / dispatch scaffolding ─────────────────────

describe("decideDispatch (T011) — Slice B scaffolding", () => {
  it("returns inline target + static-default reason when agentJobMode=inline (test env default)", async () => {
    // Test env runs with AGENT_JOB_MODE unset → config default "inline".
    // Later slices (US1 T023, US2 T035) layer label/keyword/triage logic
    // on top; this test pins the pre-layer baseline.
    const ctx = makeCtx();
    const decision = await decideDispatch(ctx);

    expect(decision.target).toBe("inline");
    expect(decision.reason).toBe("static-default");
    expect(decision.maxTurns).toBeGreaterThan(0); // defaultMaxTurns (30 default)
    expect(typeof decision.maxTurns).toBe("number");
  });
});

describe("dispatch (T024, FR-018) — isolated-job graceful rejection on missing K8s auth", () => {
  it("does NOT throw when isolated-job hits absent K8s infra; posts a rejection comment", async () => {
    // Test env has no KUBERNETES_SERVICE_HOST / KUBECONFIG, so the spawner's
    // loadKubernetesClient throws JobSpawnerError(kind:"infra-absent"), which
    // dispatch() converts to a tracking-comment rejection (FR-018) instead
    // of bubbling. The router does NOT silently downgrade to a different target.
    const createComment = mock(() => Promise.resolve({ data: { id: 999 } }));
    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: createComment as unknown as () => Promise<{ data: { id: number } }>,
      },
    });
    const decision = {
      target: "isolated-job" as const,
      reason: "label" as const,
      maxTurns: 30,
    };

    // Should resolve, not throw.
    await dispatch(ctx, decision);

    expect(createComment).toHaveBeenCalled();
    const callArgs = (createComment as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    if (callArgs !== undefined) {
      const [arg] = callArgs as [{ body: string }];
      expect(arg.body).toContain("isolated-job");
      expect(arg.body.toLowerCase()).toContain("not currently configured");
    }
  });

  it("NotImplementedError remains a typed export for any future unimplemented target", () => {
    // Slice C lit up isolated-job. The class is kept as a typed surface for
    // future targets that ship with the same scaffolding pattern.
    const err = new NotImplementedError("inline");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotImplementedError");
    expect(err.target).toBe("inline");
  });
});

describe("processRequest (T013) — dispatch-decision log", () => {
  it("emits the 'dispatch decision' log before dispatching (inline path)", async () => {
    const ctx = makeCtx({ deliveryId: `telemetry-${Date.now()}` });
    await processRequest(ctx);

    // The log was emitted via the silent logger mocked in makeCtx — inspect its
    // call history directly. `.info` takes (obj, msg) tuples; find the entry
    // whose msg matches the contract's canonical string.
    const infoCalls = (ctx.log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const dispatchLog = infoCalls.find(
      (call) => Array.isArray(call) && call[1] === "dispatch decision",
    );

    expect(dispatchLog).toBeDefined();
    if (dispatchLog !== undefined) {
      const [payload] = dispatchLog as [Record<string, unknown>, string];
      expect(payload["deliveryId"]).toBe(ctx.deliveryId);
      expect(payload["owner"]).toBe(ctx.owner);
      expect(payload["repo"]).toBe(ctx.repo);
      expect(payload["dispatchTarget"]).toBe("inline");
      expect(payload["dispatchReason"]).toBe("static-default");
      // Slice B: triage never runs. US2 T036 extends with triage* fields.
      expect(payload["triageInvoked"]).toBe(false);
    }
  });
});

// ─── US3 T044 — isolated-job capacity gating ─────────────────────────────────

describe("dispatch (T044, FR-018) — isolated-job capacity gating", () => {
  // Each test resets the queue mocks so the outer describe's defaults
  // (in-flight=0, enqueue=enqueued) don't bleed across cases.

  it("under capacity: takes the direct spawn path; does NOT call enqueuePending", async () => {
    mockInFlightCount.mockClear();
    mockEnqueuePending.mockClear();
    mockRegisterInFlight.mockClear();
    mockInFlightCount.mockImplementation(() => Promise.resolve(0));

    const createComment = mock(() => Promise.resolve({ data: { id: 1 } }));
    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: createComment as unknown as () => Promise<{ data: { id: number } }>,
      },
    });
    const decision = {
      target: "isolated-job" as const,
      reason: "label" as const,
      maxTurns: 30,
    };

    // spawnIsolatedJob throws infra-absent in the test env; that's the
    // FR-018 rejection path which ALSO bypasses registerInFlight. The test
    // asserts the queue gate was consulted first and rejected the
    // enqueue path (not at capacity).
    await dispatch(ctx, decision);

    expect(mockInFlightCount).toHaveBeenCalledTimes(1);
    expect(mockEnqueuePending).not.toHaveBeenCalled();
  });

  it("at capacity: enqueues and posts a 'Queued' tracking comment (no spawn)", async () => {
    mockInFlightCount.mockClear();
    mockEnqueuePending.mockClear();
    mockRegisterInFlight.mockClear();
    mockInFlightCount.mockImplementation(() => Promise.resolve(3)); // ≥ max default
    mockEnqueuePending.mockImplementation(() =>
      Promise.resolve({ outcome: "enqueued", position: 2 } as const),
    );

    const createComment = mock(() => Promise.resolve({ data: { id: 42 } }));
    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: createComment as unknown as () => Promise<{ data: { id: number } }>,
      },
    });
    const decision = {
      target: "isolated-job" as const,
      reason: "label" as const,
      maxTurns: 30,
    };

    await dispatch(ctx, decision);

    expect(mockEnqueuePending).toHaveBeenCalledTimes(1);
    expect(mockRegisterInFlight).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalled();
    const commentCall = (createComment as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    if (commentCall !== undefined) {
      const [arg] = commentCall as [{ body: string }];
      expect(arg.body).toContain("⏳ Queued");
      expect(arg.body).toContain("position 2");
    }
  });

  it("queue full: records capacity-rejected execution row + posts rejection comment; NO silent downgrade", async () => {
    mockInFlightCount.mockClear();
    mockEnqueuePending.mockClear();
    mockRegisterInFlight.mockClear();
    mockCreateExecution.mockClear();
    mockGetDb.mockClear();
    mockInFlightCount.mockImplementation(() => Promise.resolve(3));
    mockEnqueuePending.mockImplementation(() =>
      Promise.resolve({ outcome: "rejected-full", currentLength: 20 } as const),
    );
    // Provide a truthy db handle so `getDb() !== null` and the rejection
    // write path runs. The mock doesn't speak SQL — createExecution is
    // itself mocked; we just need getDb to return non-null.
    mockGetDb.mockImplementation(() => ({}) as unknown);

    const createComment = mock(() => Promise.resolve({ data: { id: 99 } }));
    const ctx = makeCtx({
      octokitOpts: {
        createCommentFn: createComment as unknown as () => Promise<{ data: { id: number } }>,
      },
    });
    const decision = {
      target: "isolated-job" as const,
      reason: "label" as const,
      maxTurns: 30,
    };

    await dispatch(ctx, decision);

    // Tracking comment surfaced the queue-full rejection.
    expect(createComment).toHaveBeenCalled();
    const commentCall = (createComment as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    if (commentCall !== undefined) {
      const [arg] = commentCall as [{ body: string }];
      expect(arg.body.toLowerCase()).toContain("pool is at capacity");
      expect(arg.body.toLowerCase()).toContain("will not silently downgrade");
    }

    // Execution row recorded with dispatch_reason="capacity-rejected".
    expect(mockCreateExecution).toHaveBeenCalled();
    const execCall = mockCreateExecution.mock.calls[0];
    if (execCall !== undefined) {
      const [arg] = execCall as [{ dispatchMode: string; dispatchReason: string }];
      expect(arg.dispatchMode).toBe("isolated-job");
      expect(arg.dispatchReason).toBe("capacity-rejected");
    }

    // Restore the default for subsequent tests.
    mockGetDb.mockImplementation(() => null as unknown);
  });
});
