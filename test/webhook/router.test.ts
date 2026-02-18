/**
 * Tests for the processRequest pipeline in src/webhook/router.ts.
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

// ─── Mock only modules without dedicated test files ────────────────────────

const mockCleanup = mock(() => Promise.resolve());
const mockCheckoutRepo = mock(() =>
  Promise.resolve({ workDir: "/tmp/test", cleanup: mockCleanup }),
);
const mockExecuteAgent = mock(() => Promise.resolve({ success: true, durationMs: 100 }));
const mockBuildPrompt = mock(() => "test prompt");
const mockResolveAllowedTools = mock(() => ["Bash", "Read"]);
const mockResolveMcpServers = mock(() => ({}));

// mock.module() returns void in Bun's runtime but ESLint infers a Promise from the factory.
// The void operator suppresses the no-floating-promises rule for these static mock registrations.
void mock.module("../../src/core/checkout", () => ({
  checkoutRepo: mockCheckoutRepo,
}));

void mock.module("../../src/core/executor", () => ({
  executeAgent: mockExecuteAgent,
}));

void mock.module("../../src/core/prompt-builder", () => ({
  buildPrompt: mockBuildPrompt,
  resolveAllowedTools: mockResolveAllowedTools,
}));

void mock.module("../../src/mcp/registry", () => ({
  resolveMcpServers: mockResolveMcpServers,
}));

// Import router AFTER mocks are set up
const { processRequest } = await import("../../src/webhook/router");

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
    listCommentsBodies?: Array<string | undefined>;
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
  mockCleanup.mockClear();
  mockCheckoutRepo.mockClear();
  mockExecuteAgent.mockClear();
  mockBuildPrompt.mockClear();
  mockResolveAllowedTools.mockClear();
  mockResolveMcpServers.mockClear();

  mockCleanup.mockResolvedValue(undefined);
  mockCheckoutRepo.mockResolvedValue({ workDir: "/tmp/test", cleanup: mockCleanup });
  mockExecuteAgent.mockResolvedValue({ success: true, durationMs: 100 });
  mockBuildPrompt.mockReturnValue("test prompt");
  mockResolveAllowedTools.mockReturnValue(["Bash", "Read"]);
  mockResolveMcpServers.mockReturnValue({});
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

describe("processRequest — error handling", () => {
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
    const calls = updateCommentSpy.mock.calls as Array<[{ body: string }]>;
    expect(calls.length).toBeGreaterThan(0);
    // calls.length > 0 is asserted above; the non-null cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const finalBody = calls[calls.length - 1]![0].body;
    expect(finalBody).not.toContain("sk-ant-secret");
    expect(finalBody).not.toContain("invalid API key");
    expect(finalBody).not.toContain("401");
    expect(finalBody).toContain("internal error");
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

describe("processRequest — successful execution", () => {
  it("finalizes comment with success content after a successful run", async () => {
    mockExecuteAgent.mockResolvedValue({ success: true, durationMs: 3000, costUsd: 0.05 });
    const ctx = makeCtx();
    const updateCommentSpy = ctx.octokit.rest.issues.updateComment as ReturnType<typeof mock>;

    await processRequest(ctx);

    const calls = updateCommentSpy.mock.calls as Array<[{ body: string }]>;
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
