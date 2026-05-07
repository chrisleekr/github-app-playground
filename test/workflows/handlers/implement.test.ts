/**
 * Unit tests for the `implement` handler — focused on the post-pipeline
 * "did the agent open a PR?" verifier.
 *
 * Background: in `GITHUB_PERSONAL_ACCESS_TOKEN` mode the bot authors PRs as
 * a real user (`pr.user.type === "User"`). The pre-fix verifier filtered on
 * `type === "Bot"`, which made every PAT-mode implement run report
 * `"implement completed but no PR was found"` even though the PR was opened
 * correctly. These tests pin both modes so the regression can't return.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunContext } from "../../../src/workflows/registry";

const mockConfig: { githubPersonalAccessToken: string | undefined } = {
  githubPersonalAccessToken: undefined,
};

void mock.module("../../../src/config", () => ({ config: mockConfig }));

let pipelineResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  capturedFiles?: Record<string, string>;
};

void mock.module("../../../src/core/pipeline", () => ({
  runPipeline: mock(() => Promise.resolve(pipelineResult)),
}));

void mock.module("../../../src/workflows/runs-store", () => ({
  findLatestSucceededForTarget: mock(() =>
    Promise.resolve({
      id: "plan-row-1",
      state: { plan: "## Plan\n\nDo the thing." },
    }),
  ),
}));

const { handler: implementHandler } = await import("../../../src/workflows/handlers/implement");

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

interface PrStub {
  number: number;
  type: "Bot" | "User";
  login: string;
  createdAtOffsetMs?: number;
  branch?: string;
}

function buildCtx(
  prs: PrStub[],
  options?: { authenticatedLogin?: string },
): WorkflowRunContext & { setStateMock: ReturnType<typeof mock> } {
  // Anchor created_at to "now" so the handler's `since` window includes them.
  const now = Date.now();
  const prData = prs.map((p) => ({
    number: p.number,
    html_url: `https://github.com/acme/widgets/pull/${String(p.number)}`,
    head: { ref: p.branch ?? `feat/issue-1-${String(p.number)}` },
    user: { type: p.type, login: p.login },
    created_at: new Date(now + (p.createdAtOffsetMs ?? 1000)).toISOString(),
  }));

  const octokit = {
    rest: {
      issues: {
        get: mock(() =>
          Promise.resolve({
            data: { title: "Implement the thing", user: { login: "humanA" } },
          }),
        ),
      },
      repos: {
        get: mock(() => Promise.resolve({ data: { default_branch: "main" } })),
      },
      pulls: {
        list: mock(() => Promise.resolve({ data: prData })),
      },
      users: {
        getAuthenticated: mock(() =>
          Promise.resolve({
            data: { login: options?.authenticatedLogin ?? "chrisleekr" },
          }),
        ),
      },
    },
  } as unknown as Octokit;

  const setStateMock = mock(() => Promise.resolve());

  return {
    runId: "run-1",
    workflowName: "implement",
    target: { type: "issue", owner: "acme", repo: "widgets", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "delivery-1",
    daemonId: "daemon-1",
    setState: setStateMock,
    setStateMock,
  } as unknown as WorkflowRunContext & { setStateMock: ReturnType<typeof mock> };
}

describe("implement handler — findRecentOpenedPr", () => {
  beforeEach(() => {
    pipelineResult = {
      success: true,
      costUsd: 0.5,
      numTurns: 8,
      durationMs: 12_000,
      capturedFiles: { "IMPLEMENT.md": "## Summary\n\nImplemented." },
    };
    mockConfig.githubPersonalAccessToken = undefined;
  });

  afterEach(() => {
    mockConfig.githubPersonalAccessToken = undefined;
  });

  it("App mode: accepts a PR authored by the App bot", async () => {
    const ctx = buildCtx([{ number: 107, type: "Bot", login: "chrisleekr-bot[bot]" }]);
    const result = await implementHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.state["pr_number"]).toBe(107);
    }
  });

  it("App mode: rejects a PR authored by a User account", async () => {
    const ctx = buildCtx([{ number: 107, type: "User", login: "chrisleekr" }]);
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("implement completed but no PR was found");
    }
  });

  it("PAT mode: accepts a PR authored by the PAT owner (regression: User type)", async () => {
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([{ number: 107, type: "User", login: "chrisleekr" }], {
      authenticatedLogin: "chrisleekr",
    });
    const result = await implementHandler(ctx);
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      expect(result.state["pr_number"]).toBe(107);
    }
  });

  it("PAT mode: rejects a PR authored by an unrelated bot", async () => {
    mockConfig.githubPersonalAccessToken = "ghp_test_token";
    const ctx = buildCtx([{ number: 107, type: "Bot", login: "renovate[bot]" }], {
      authenticatedLogin: "chrisleekr",
    });
    const result = await implementHandler(ctx);
    expect(result.status).toBe("failed");
  });
});
