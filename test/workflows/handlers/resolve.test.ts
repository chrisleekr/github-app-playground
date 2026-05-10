/**
 * Unit tests for the `resolve` handler: focused on the post-pipeline CI
 * re-check gate added for issue #93.
 *
 * The handler delegates the heavy lifting to `runPipeline` (clone + multi-
 * turn agent). These tests stub the pipeline and the GitHub REST surface to
 * exercise the wiring around it: prologue check fetch, post-pipeline
 * re-fetch, RESOLVE.md `## Outstanding` parsing, and the `succeeded` vs.
 * `incomplete` branch decision.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunContext } from "../../../src/workflows/registry";

interface PipelineResultStub {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  errorMessage?: string;
  capturedFiles?: Record<string, string>;
}

let pipelineResult: PipelineResultStub;

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mock(async () => Promise.resolve(pipelineResult)),
}));

void mock.module("../../../src/workflows/runs-store", () => ({
  findById: mock(async () =>
    Promise.resolve({
      id: "run-1",
      tracking_comment_id: 12345,
    }),
  ),
}));

const { handler: resolveHandler } = await import("../../../src/workflows/handlers/resolve");

function silentLog(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

interface CheckRunStub {
  status: string | null;
  conclusion: string | null;
  name: string;
}

interface BuildCtxOptions {
  state?: "open" | "closed";
  /** Pre-pipeline checks (handler prologue snapshot). */
  preChecks?: CheckRunStub[];
  /** Post-pipeline checks (handler re-fetch after `runPipeline`). */
  postChecks?: CheckRunStub[];
  /**
   * SHA returned by the second `pulls.get` call (post-pipeline). Defaults to
   * a different value from the first `pulls.get` call so the test doubles
   * see a "the agent pushed commits" scenario.
   */
  postHeadSha?: string;
  reviewComments?: { in_reply_to_id?: number }[];
  targetType?: "pr" | "issue";
}

function buildCtx(opts: BuildCtxOptions = {}): WorkflowRunContext & {
  setStateMock: ReturnType<typeof mock>;
  paginateMock: ReturnType<typeof mock>;
} {
  const preChecks = opts.preChecks ?? [];
  const postChecks = opts.postChecks ?? [];
  const reviewComments = opts.reviewComments ?? [];
  const postHeadSha = opts.postHeadSha ?? "abc1234";

  const prData = (sha: string) => ({
    state: opts.state ?? "open",
    title: "Sample PR",
    head: {
      ref: "feature/foo",
      sha,
      label: "acme:feature/foo",
      repo: { full_name: "acme/widgets" },
    },
    base: {
      ref: "main",
      repo: { full_name: "acme/widgets", default_branch: "main" },
    },
  });

  // Two calls to pulls.get: one in the prologue, one after runPipeline.
  let pullsGetCallCount = 0;
  const pullsGet = mock(async () => {
    pullsGetCallCount += 1;
    if (pullsGetCallCount === 1) return Promise.resolve({ data: prData("oldsha000") });
    return Promise.resolve({ data: prData(postHeadSha) });
  });

  // paginate handles both `checks.listForRef` (with `ref` arg) and
  // `pulls.listReviewComments`. We dispatch on the second arg's keys so the
  // same mock can serve both call sites.
  const paginate = mock((endpoint: unknown, args: Record<string, unknown>) => {
    if ("ref" in args) {
      // checks.listForRef, return pre-snapshot the first time, post-snapshot
      // the second time. Distinguish by `ref`: prologue uses "oldsha000",
      // post-pipeline uses postHeadSha.
      if (args["ref"] === postHeadSha && postHeadSha !== "oldsha000") {
        return Promise.resolve(postChecks);
      }
      return Promise.resolve(preChecks);
    }
    if ("pull_number" in args) return Promise.resolve(reviewComments);
    return Promise.resolve([]);
  });

  const octokit = {
    paginate,
    rest: {
      pulls: {
        get: pullsGet,
        listReviewComments: mock(),
      },
      checks: {
        listForRef: mock(),
      },
      repos: {
        compareCommitsWithBasehead: mock(async () =>
          Promise.resolve({ data: { behind_by: 0, ahead_by: 1 } }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve());

  return {
    runId: "run-1",
    workflowName: "resolve",
    target: {
      type: opts.targetType ?? "pr",
      owner: "acme",
      repo: "widgets",
      number: 99,
    },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: setStateMock,
    setStateMock,
    paginateMock: paginate,
  } as unknown as WorkflowRunContext & {
    setStateMock: ReturnType<typeof mock>;
    paginateMock: ReturnType<typeof mock>;
  };
}

describe("resolve handler", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.5,
      numTurns: 10,
      durationMs: 30_000,
      capturedFiles: { "RESOLVE.md": "## Summary\n\nDone." },
    };
  });

  afterEach(() => {
    pipelineResult = { success: false };
  });

  it("rejects an issue target", async () => {
    const ctx = buildCtx({ targetType: "issue" });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("PR target");
  });

  it("rejects a closed PR", async () => {
    const ctx = buildCtx({ state: "closed" });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.reason).toContain("open PR");
  });

  it("returns succeeded when post-pipeline CI is green and RESOLVE.md has no Outstanding", async () => {
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "test" }],
      postChecks: [
        { status: "completed", conclusion: "success", name: "test" },
        { status: "completed", conclusion: "skipped", name: "optional" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(true);
      const post = state["post_pipeline"] as Record<string, unknown>;
      expect(post["all_green"]).toBe(true);
      expect(post["failing_checks"]).toEqual([]);
    }
    expect(ctx.setStateMock).toHaveBeenCalledTimes(2);
  });

  it("returns incomplete when post-pipeline CI still has failing checks", async () => {
    pipelineResult = {
      success: true,
      costUsd: 1.0,
      numTurns: 20,
      capturedFiles: {
        "RESOLVE.md":
          "## Summary\n\nGave up.\n\n## Outstanding\n\n- typecheck still red, could not isolate root cause",
      },
    };
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "typecheck" }],
      postChecks: [{ status: "completed", conclusion: "failure", name: "typecheck" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.reason).toContain("CI still red");
      expect(result.reason).toContain("typecheck");
      expect(result.humanMessage).toContain("Resolve incomplete");
      expect(result.humanMessage).toContain("typecheck still red");
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(false);
      const post = state["post_pipeline"] as Record<string, unknown>;
      expect(post["all_green"]).toBe(false);
      expect(post["failing_checks"]).toEqual(["typecheck"]);
      expect(post["outstanding_present"]).toBe(true);
    }
  });

  it("returns incomplete when CI is green but ## Outstanding is non-empty", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0.7,
      numTurns: 14,
      capturedFiles: {
        "RESOLVE.md":
          "## Summary\n\nMostly done.\n\n## Outstanding\n\n- maintainer must verify edge case in src/foo.ts",
      },
    };
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [{ status: "completed", conclusion: "success", name: "test" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.reason).toContain("Outstanding");
      expect(result.humanMessage).toContain("maintainer must verify edge case");
    }
  });

  it("returns succeeded when RESOLVE.md is missing entirely (and CI green)", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0.1,
      numTurns: 3,
      capturedFiles: {},
    };
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [{ status: "completed", conclusion: "success", name: "test" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["ci_verified"]).toBe(true);
    }
  });

  it("partial CI green still returns incomplete", async () => {
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [
        { status: "completed", conclusion: "success", name: "lint" },
        { status: "completed", conclusion: "failure", name: "test" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("incomplete");
  });

  it("all-skipped/neutral checks are treated as green", async () => {
    const ctx = buildCtx({
      preChecks: [],
      postChecks: [
        { status: "completed", conclusion: "skipped", name: "deploy" },
        { status: "completed", conclusion: "neutral", name: "info" },
      ],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("succeeded");
  });

  it("returns failed when runPipeline reports failure (regression guard)", async () => {
    pipelineResult = { success: false, errorMessage: "agent crashed" };
    const ctx = buildCtx({
      preChecks: [{ status: "completed", conclusion: "failure", name: "test" }],
    });
    const result = await resolveHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agent crashed");
      expect(result.humanMessage).toContain("see server logs");
    }
  });
});
