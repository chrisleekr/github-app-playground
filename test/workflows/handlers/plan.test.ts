/**
 * Unit tests for the SDK-driven plan handler.
 *
 * The handler clones the repo and runs Claude Agent SDK; the agent writes
 * PLAN.md. The unit tests stub `checkoutRepo`, `executeAgent`, and
 * `node:fs/promises.readFile` to drive the post-agent branches without
 * standing up real infra.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import { config } from "../../../src/config";
import type { WorkflowRunContext } from "../../../src/workflows/registry";

let agentResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
};
let planMd: string;

void mock.module("../../../src/core/checkout", () => ({
  checkoutRepo: mock(async () =>
    Promise.resolve({
      workDir: "/tmp/fake-workdir",
      cleanup: mock(async () => Promise.resolve()),
    }),
  ),
}));

// Hoisted so tests can inspect the params the handler forwards (e.g. whether
// `promptParts` is threaded through under PROMPT_CACHE_LAYOUT=cacheable).
const executeAgentMock = mock(async () => Promise.resolve(agentResult));
void mock.module("../../../src/core/executor", () => ({
  executeAgent: executeAgentMock,
}));

// Spread the real fs/promises so other test files' uses of writeFile, mkdir,
// etc. still work even though Bun's mock.module replacement is process-global.
const realFsPromises = await import("node:fs/promises");
void mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readFile: mock(async (path: string) => {
    if (path.endsWith("PLAN.md")) return Promise.resolve(planMd);
    return realFsPromises.readFile(path, "utf8");
  }),
}));

const { handler: planHandler } = await import("../../../src/workflows/handlers/plan");

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

function buildCtx(): WorkflowRunContext {
  const octokit = {
    rest: {
      issues: {
        get: mock(async () =>
          Promise.resolve({
            data: { title: "Sample issue", body: "Sample body", user: { login: "alice" } },
          }),
        ),
      },
      repos: {
        get: mock(async () => Promise.resolve({ data: { default_branch: "main" } })),
      },
    },
    auth: mock(async () => Promise.resolve({ token: "ghs_fake" })),
  } as unknown as Octokit;

  return {
    runId: "run-1",
    workflowName: "plan",
    target: { type: "issue", owner: "acme", repo: "repo", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "d1",
    daemonId: "daemon-test",
    setState: mock(async () => Promise.resolve()),
  };
}

beforeEach(() => {
  executeAgentMock.mockClear();
  agentResult = { success: true, costUsd: 0.05, numTurns: 8, durationMs: 20_000 };
  planMd = "# Plan: Sample issue\n\n## Tasks\n- [ ] T1 do the thing (files: src/foo.ts)";
});

const ORIGINAL_PROMPT_CACHE_LAYOUT = config.promptCacheLayout;

afterEach(() => {
  mock.restore();
  config.promptCacheLayout = ORIGINAL_PROMPT_CACHE_LAYOUT;
});

describe("plan handler (SDK-driven)", () => {
  it("returns succeeded with the PLAN.md body as state", async () => {
    const result = await planHandler(buildCtx());

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { plan: string; turns: number };
      expect(state.plan).toContain("## Tasks");
      expect(state.turns).toBe(8);
      expect(result.humanMessage).toContain("Plan ready");
    }
  });

  it("fails when the agent itself errors", async () => {
    agentResult = { success: false, durationMs: 5_000 };

    const result = await planHandler(buildCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agent execution failed");
    }
  });

  it("fails when PLAN.md is missing", async () => {
    planMd = "";

    const result = await planHandler(buildCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("PLAN.md");
    }
  });

  it("does not forward promptParts under the legacy layout", async () => {
    config.promptCacheLayout = "legacy";
    await planHandler(buildCtx());

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const params = executeAgentMock.mock.calls[0]?.[0] as { promptParts?: unknown };
    expect(params.promptParts).toBeUndefined();
  });

  it("forwards split promptParts to the executor under the cacheable layout", async () => {
    config.promptCacheLayout = "cacheable";
    await planHandler(buildCtx());

    expect(executeAgentMock).toHaveBeenCalledTimes(1);
    const params = executeAgentMock.mock.calls[0]?.[0] as {
      promptParts?: { append: string; userMessage: string };
    };
    expect(params.promptParts).toBeDefined();
    expect(params.promptParts?.append.length).toBeGreaterThan(0);
    expect(params.promptParts?.userMessage.length).toBeGreaterThan(0);
  });
});
