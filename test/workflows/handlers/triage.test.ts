/**
 * Unit tests for the SDK-driven triage handler.
 *
 * The handler clones the repo and runs Claude Agent SDK; the agent writes
 * TRIAGE.md + TRIAGE_VERDICT.json. The unit tests stub `checkoutRepo`,
 * `executeAgent`, and `node:fs/promises.readFile` to drive the post-agent
 * branches without standing up real infra.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowRunContext } from "../../../src/workflows/registry";

let agentResult: {
  success: boolean;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
};
let triageMd: string;
let triageVerdict: string;

void mock.module("../../../src/core/checkout", () => ({
  checkoutRepo: mock(async () =>
    Promise.resolve({
      workDir: "/tmp/fake-workdir",
      cleanup: mock(async () => Promise.resolve()),
    }),
  ),
}));

void mock.module("../../../src/core/executor", () => ({
  executeAgent: mock(async () => Promise.resolve(agentResult)),
}));

// Spread the real fs/promises so other test files' uses of writeFile, mkdir,
// etc. still work even though Bun's mock.module replacement is process-global.
const realFsPromises = await import("node:fs/promises");
void mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readFile: mock(async (path: string) => {
    if (path.endsWith("TRIAGE.md")) return Promise.resolve(triageMd);
    if (path.endsWith("TRIAGE_VERDICT.json")) return Promise.resolve(triageVerdict);
    return realFsPromises.readFile(path, "utf8");
  }),
}));

const { handler: triageHandler } = await import("../../../src/workflows/handlers/triage");

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

function buildCtx(issueOverrides?: { title?: string; body?: string }): WorkflowRunContext & {
  setStateMock: ReturnType<typeof mock>;
} {
  const octokit = {
    rest: {
      issues: {
        get: mock(async () =>
          Promise.resolve({
            data: {
              title: issueOverrides?.title ?? "Sample issue",
              body: issueOverrides?.body ?? "Sample body",
            },
          }),
        ),
      },
      repos: {
        get: mock(async () => Promise.resolve({ data: { default_branch: "main" } })),
      },
    },
    auth: mock(async () => Promise.resolve({ token: "ghs_fake" })),
  } as unknown as Octokit;

  const setStateMock = mock(async () => Promise.resolve());
  return {
    runId: "run-1",
    workflowName: "triage",
    target: { type: "issue", owner: "acme", repo: "repo", number: 1 },
    logger: silentLog(),
    octokit,
    deliveryId: "d1",
    daemonId: "daemon-test",
    setState: setStateMock,
    setStateMock,
  };
}

beforeEach(() => {
  agentResult = { success: true, costUsd: 0.05, numTurns: 12, durationMs: 30_000 };
  triageMd = "# Triage\n\nValid bug, evidence at src/foo.ts:42.";
  triageVerdict = JSON.stringify({
    valid: true,
    confidence: 0.92,
    summary: "Reproduced, cache TTL is 0 in src/foo.ts:42.",
    recommendedNext: "plan",
    evidence: [{ file: "src/foo.ts", line: 42, note: "cache TTL hard-coded to 0" }],
    reproduction: {
      attempted: true,
      reproduced: true,
      details: "Ran `bun test test/cache.test.ts`; cache.get returned undefined immediately.",
    },
  });
});

afterEach(() => {
  mock.restore();
});

describe("triage handler (SDK-driven)", () => {
  it("returns succeeded when verdict is valid", async () => {
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as {
        valid: boolean;
        recommendedNext: string;
        confidence: number;
        evidence: unknown[];
        reproduction: { attempted: boolean; reproduced: boolean | null; details: string };
      };
      expect(state.valid).toBe(true);
      expect(state.recommendedNext).toBe("plan");
      expect(state.confidence).toBe(0.92);
      expect(state.evidence).toHaveLength(1);
      expect(state.reproduction.attempted).toBe(true);
      expect(state.reproduction.reproduced).toBe(true);
      expect(state.reproduction.details).toContain("bun test");
      expect(result.humanMessage).toContain("Valid");
      expect(result.humanMessage).toContain("src/foo.ts:42");
    }
  });

  it("accepts a non-bug verdict where reproduction was skipped", async () => {
    triageVerdict = JSON.stringify({
      valid: true,
      confidence: 0.85,
      summary: "Feature request, adds caching to /search endpoint.",
      recommendedNext: "plan",
      evidence: [],
      reproduction: {
        attempted: false,
        reproduced: null,
        details: "Not a bug claim, feature request, reproduction skipped.",
      },
    });
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as {
        reproduction: { attempted: boolean; reproduced: boolean | null };
      };
      expect(state.reproduction.attempted).toBe(false);
      expect(state.reproduction.reproduced).toBeNull();
    }
  });

  it("rejects a verdict that omits the reproduction field", async () => {
    triageVerdict = JSON.stringify({
      valid: true,
      confidence: 0.9,
      summary: "Looks fine.",
      recommendedNext: "plan",
      evidence: [],
      // no reproduction, schema must reject
    });
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("TRIAGE_VERDICT.json failed validate");
    }
  });

  it("returns failed when verdict is invalid (halts ship cascade)", async () => {
    triageVerdict = JSON.stringify({
      valid: false,
      confidence: 0.88,
      summary: "Already fixed in commit abc123.",
      recommendedNext: "stop",
      evidence: [],
      reproduction: {
        attempted: true,
        reproduced: false,
        details: "Ran `bun test test/cache.test.ts`; all 4 tests pass, bug already fixed.",
      },
    });
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("triage rejected as invalid");
      expect(result.reason).toContain("Already fixed");
      expect(result.humanMessage).toContain("Invalid");
      const state = result.state as { valid: boolean };
      expect(state.valid).toBe(false);
    }
  });

  it("fails when the agent itself errors", async () => {
    agentResult = { success: false, durationMs: 5_000 };
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agent execution failed");
    }
  });

  it("fails when TRIAGE.md is missing", async () => {
    triageMd = "";
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("TRIAGE.md");
    }
  });

  it("fails when TRIAGE_VERDICT.json is malformed", async () => {
    triageVerdict = "{ not valid json";
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("TRIAGE_VERDICT.json failed parse");
    }
  });

  it("accepts evidence entries with note but no file (cross-cutting observations)", async () => {
    triageVerdict = JSON.stringify({
      valid: true,
      confidence: 0.9,
      summary: "Reproduced, non-constant-time bearer comparison.",
      recommendedNext: "plan",
      evidence: [
        { file: "src/orchestrator/ws-server.ts", line: 52, note: "plain !== check" },
        { note: "grep timingSafeEqual src/ returns 0 hits" },
      ],
      reproduction: {
        attempted: true,
        reproduced: true,
        details: "Code inspection confirms structural defect at cited line.",
      },
    });
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const state = result.state as { evidence: unknown[] };
      expect(state.evidence).toHaveLength(2);
    }
  });

  it("rejects evidence entries that have neither file nor note (validate)", async () => {
    triageVerdict = JSON.stringify({
      valid: true,
      confidence: 0.9,
      summary: "x",
      recommendedNext: "plan",
      evidence: [{ line: 10 }],
      reproduction: { attempted: false, reproduced: null, details: "skipped" },
    });
    const ctx = buildCtx();

    const result = await triageHandler(ctx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("TRIAGE_VERDICT.json failed validate");
    }
  });

  it("fails when target is a PR rather than an issue", async () => {
    const ctx = buildCtx();
    const prCtx: WorkflowRunContext = { ...ctx, target: { ...ctx.target, type: "pr" } };

    const result = await triageHandler(prCtx);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("issue target");
    }
  });
});
