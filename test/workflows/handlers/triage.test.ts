/**
 * Unit tests for the triage handler (T013).
 *
 * Stubs Octokit + the `setState` binding on the WorkflowRunContext. Asserts:
 *   - Success returns `status: "succeeded"` with `state.verdict` populated
 *   - `setState` is called exactly once with the final verdict
 *   - Handler never throws on the happy path
 *   - Keyword heuristics classify bug / feature / question / unclear branches
 */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import { handler as triageHandler } from "../../../src/workflows/handlers/triage";
import type { WorkflowRunContext } from "../../../src/workflows/registry";

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

function buildCtx(issue: { title: string; body: string }): WorkflowRunContext & {
  setStateMock: ReturnType<typeof mock>;
} {
  const issuesGet = mock(async () =>
    Promise.resolve({
      data: { title: issue.title, body: issue.body },
    }),
  );
  const octokit = {
    rest: { issues: { get: issuesGet } },
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve());

  return {
    runId: "run-1",
    workflowName: "triage",
    target: { type: "issue", owner: "acme", repo: "repo", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "d1",
    setState: setStateMock,
    setStateMock,
  };
}

describe("triage handler", () => {
  it("classifies bug-sounding issues as verdict=bug with next=plan", async () => {
    const ctx = buildCtx({ title: "Server crash on startup", body: "The app fails to boot." });

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { verdict: string; recommendedNext: string };
      expect(state.verdict).toBe("bug");
      expect(state.recommendedNext).toBe("plan");
    }
    expect(ctx.setStateMock).toHaveBeenCalledTimes(1);
  });

  it("classifies feature-sounding issues as verdict=feature with next=plan", async () => {
    const ctx = buildCtx({ title: "Add dark mode support", body: "Users want a dark theme." });

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { verdict: string; recommendedNext: string };
      expect(state.verdict).toBe("feature");
      expect(state.recommendedNext).toBe("plan");
    }
  });

  it("classifies question-sounding issues as verdict=question with next=clarify", async () => {
    const ctx = buildCtx({
      title: "How do I configure ALLOWED_OWNERS?",
      body: "Docs are unclear.",
    });

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { verdict: string; recommendedNext: string };
      expect(state.verdict).toBe("question");
      expect(state.recommendedNext).toBe("clarify");
    }
  });

  it("classifies ambiguous text as verdict=unclear with next=clarify", async () => {
    const ctx = buildCtx({ title: "Thoughts", body: "Random musing." });

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { verdict: string; recommendedNext: string };
      expect(state.verdict).toBe("unclear");
      expect(state.recommendedNext).toBe("clarify");
    }
  });

  it("returns failed when the Octokit issues.get call rejects", async () => {
    const ctx = buildCtx({ title: "Irrelevant", body: "" });
    const octokitFail = {
      rest: {
        issues: {
          get: mock(() => Promise.reject(new Error("404 Not Found"))),
        },
      },
    } as unknown as Octokit;
    const ctxWithFailingOctokit: WorkflowRunContext = { ...ctx, octokit: octokitFail };

    const result = await triageHandler(ctxWithFailingOctokit);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("404");
    }
  });
});
