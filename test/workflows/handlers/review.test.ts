/**
 * Unit tests for the proactive `review` handler.
 *
 * The handler delegates the heavy lifting to `runPipeline` (clone +
 * multi-turn agent). The unit tests stub `runPipeline` to assert the
 * handler's pre/post wiring: PR-target validation, open-PR check,
 * REVIEW.md capture, state shape, and the human-readable headline.
 *
 * The agent's actual behaviour (reading files, posting findings via
 * `gh api`) is covered by the integration smoke test, not here: that
 * needs a real PR and is out of scope for unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunContext } from "../../../src/workflows/registry";

let pipelineResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  capturedFiles?: Record<string, string>;
};

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mock(async () => Promise.resolve(pipelineResult)),
}));

// Stub the runs-store DB read, the handler reads back the seeded
// tracking_comment_id after the first setState call. Tests don't run
// against a real DB, so return a row with a deterministic id.
void mock.module("../../../src/workflows/runs-store", () => ({
  findById: mock(async () =>
    Promise.resolve({
      id: "run-1",
      tracking_comment_id: 12345,
    }),
  ),
}));

const { handler: reviewHandler } = await import("../../../src/workflows/handlers/review");

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

interface PrOverrides {
  state?: "open" | "closed";
  title?: string;
  body?: string | null;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  /** Default 0, branch is up-to-date. */
  behindBy?: number;
  /** Default false, head is on the same repo as base. */
  isFork?: boolean;
}

function buildCtx(
  prOverrides?: PrOverrides,
  targetType: "pr" | "issue" = "pr",
): WorkflowRunContext & { setStateMock: ReturnType<typeof mock> } {
  const isFork = prOverrides?.isFork ?? false;
  const headRepoFullName = isFork ? "fork/widgets" : "acme/widgets";

  const prData = {
    state: prOverrides?.state ?? "open",
    title: prOverrides?.title ?? "Sample PR",
    body: prOverrides?.body ?? "PR description",
    changed_files: prOverrides?.changedFiles ?? 3,
    additions: prOverrides?.additions ?? 42,
    deletions: prOverrides?.deletions ?? 7,
    head: {
      ref: "feature/foo",
      sha: "abc1234",
      label: "acme:feature/foo",
      repo: { full_name: headRepoFullName },
    },
    base: {
      ref: "main",
      repo: { full_name: "acme/widgets", default_branch: "main" },
    },
  };

  const octokit = {
    rest: {
      pulls: {
        get: mock(async () => Promise.resolve({ data: prData })),
      },
      repos: {
        compareCommitsWithBasehead: mock(async () =>
          Promise.resolve({
            data: {
              behind_by: prOverrides?.behindBy ?? 0,
              ahead_by: 5,
            },
          }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve());

  return {
    runId: "run-1",
    workflowName: "review",
    target: { type: targetType, owner: "acme", repo: "widgets", number: 99 },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: setStateMock,
    setStateMock,
  } as unknown as WorkflowRunContext & { setStateMock: ReturnType<typeof mock> };
}

describe("review handler", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.42,
      numTurns: 12,
      durationMs: 60000,
      capturedFiles: {
        "REVIEW.md":
          "## Summary\n\nReviewed 3 files. One inline finding posted.\n\n## What was checked\n\n- src/foo.ts\n- src/bar.ts\n- src/baz.ts\n\n## Findings\n\n- [major] src/foo.ts:42, example finding for the test fixture",
      },
    };
  });

  afterEach(() => {
    pipelineResult = { success: false };
  });

  it("rejects an issue target", async () => {
    const ctx = buildCtx(undefined, "issue");
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("PR target");
    }
  });

  it("rejects a closed PR", async () => {
    const ctx = buildCtx({ state: "closed" });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("closed");
      expect(result.reason).toContain("open PR");
    }
  });

  it("succeeds and captures REVIEW.md when pipeline succeeds", async () => {
    const ctx = buildCtx({ changedFiles: 5, additions: 100, deletions: 20 });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as Record<string, unknown>;
      expect(state["pr_number"]).toBe(99);
      expect(state["changed_files"]).toBe(5);
      expect(state["additions"]).toBe(100);
      expect(state["deletions"]).toBe(20);
      expect(state["report"]).toContain("Reviewed 3 files");
      expect(state["findings"]).toEqual({
        blocker: 0,
        major: 1,
        minor: 0,
        nit: 0,
        total: 1,
      });
      expect(state["costUsd"]).toBe(0.42);
      expect(state["turns"]).toBe(12);
      const branch = state["branch_state"] as Record<string, unknown>;
      expect(branch["commits_behind_base"]).toBe(0);
      expect(branch["is_fork"]).toBe(false);
    }
    // Two setState calls: (1) seed before pipeline, (2) finalize after.
    expect(ctx.setStateMock).toHaveBeenCalledTimes(2);
    const seedArgs = ctx.setStateMock.mock.calls[0] as [unknown, string];
    expect(seedArgs[1]).toContain("Code review starting");
    expect(seedArgs[1]).toContain("5 files");
    const finalArgs = ctx.setStateMock.mock.calls[1] as [unknown, string];
    expect(finalArgs[1]).toContain("Code review complete");
    expect(finalArgs[1]).toContain("5 files");
    expect(finalArgs[1]).toContain("+100/-20");
    expect(finalArgs[1]).toContain("Reviewed 3 files");
  });

  it("records commits_behind_base when the branch is stale", async () => {
    const ctx = buildCtx({ behindBy: 7 });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { branch_state: Record<string, unknown> };
      expect(state.branch_state["commits_behind_base"]).toBe(7);
      expect(state.branch_state["is_fork"]).toBe(false);
    }
  });

  it("flags fork PRs in branch_state so the agent knows it can't push", async () => {
    const ctx = buildCtx({ behindBy: 3, isFork: true });
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { branch_state: Record<string, unknown> };
      expect(state.branch_state["commits_behind_base"]).toBe(3);
      expect(state.branch_state["is_fork"]).toBe(true);
    }
  });

  it("falls back to a placeholder when REVIEW.md is missing", async () => {
    pipelineResult = {
      success: true,
      costUsd: 0,
      numTurns: 1,
      durationMs: 1000,
      capturedFiles: {},
    };
    const ctx = buildCtx();
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("succeeded");
    // calls[0] is the seed; the placeholder appears in the finalize call.
    const finalArgs = ctx.setStateMock.mock.calls[1] as [unknown, string];
    expect(finalArgs[1]).toContain("no REVIEW.md report");
  });

  it("fails when the pipeline reports failure", async () => {
    pipelineResult = { success: false };
    const ctx = buildCtx();
    const result = await reviewHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("pipeline");
    }
  });
});

describe("countFindings", () => {
  it("counts severity tags case-insensitively and excludes nits from total", async () => {
    const { countFindings } = await import("../../../src/workflows/handlers/review");
    const report = `## Summary

Found 4 issues.

[blocker] Null deref on line 12.
[major] Missing test for X.
[Major] Race condition in Y.
[minor] Inefficient sort.
[NIT] Variable name could be clearer.`;
    expect(countFindings(report)).toEqual({
      blocker: 1,
      major: 2,
      minor: 1,
      nit: 1,
      total: 4,
    });
  });

  it("returns all-zeros for an empty or no-findings report", async () => {
    const { countFindings } = await import("../../../src/workflows/handlers/review");
    expect(countFindings("")).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0, total: 0 });
    expect(countFindings("## Summary\n\nNo findings, all clean.")).toEqual({
      blocker: 0,
      major: 0,
      minor: 0,
      nit: 0,
      total: 0,
    });
  });
});
