/**
 * Tests for `runShipFromCommand` (T028 v2 entry).
 *
 * Verifies the three control-flow gates that protect ship_intents writes
 * and the FR-019 ready-for-review terminal action. Real DB; mocked
 * octokit per Constitution V.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import type { CanonicalCommand } from "../../../src/shared/ship-types";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available — test should have been skipped");
  return sql;
}

void mock.module("../../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

const { runShipFromCommand } = await import("../../../src/workflows/ship/session-runner");

interface OctokitCalls {
  graphqlCalls: { query: string; vars: unknown }[];
  createCommentCalls: unknown[];
  updateCommentCalls: unknown[];
}

interface BuildOctokitInput {
  readonly eligibilityResponse?: unknown;
  readonly probeResponse?: unknown;
  readonly prIdResponse?: unknown;
  readonly markReadyResponse?: unknown;
  readonly throwOnGraphql?: string;
}

function buildOctokit(input: BuildOctokitInput): { octokit: Octokit; calls: OctokitCalls } {
  const calls: OctokitCalls = {
    graphqlCalls: [],
    createCommentCalls: [],
    updateCommentCalls: [],
  };

  const graphql = (query: string, vars: unknown): Promise<unknown> => {
    calls.graphqlCalls.push({ query, vars });
    if (input.throwOnGraphql !== undefined && query.includes(input.throwOnGraphql)) {
      return Promise.reject(new Error("forced graphql failure"));
    }
    if (query.includes("query Eligibility")) {
      return Promise.resolve(input.eligibilityResponse);
    }
    if (query.includes("query MergeReadinessProbe")) {
      return Promise.resolve(input.probeResponse);
    }
    if (query.includes("query GetPrId")) {
      return Promise.resolve(input.prIdResponse);
    }
    if (query.includes("mutation MarkReady")) {
      return Promise.resolve(input.markReadyResponse);
    }
    return Promise.reject(new Error(`unmocked graphql: ${query.slice(0, 50)}`));
  };

  const octokit = {
    graphql,
    rest: {
      issues: {
        createComment: (params: unknown) => {
          calls.createCommentCalls.push(params);
          return Promise.resolve({ data: { id: 12345 } });
        },
        updateComment: (params: unknown) => {
          calls.updateCommentCalls.push(params);
          return Promise.resolve({ data: {} });
        },
      },
    },
  } as unknown as Octokit;

  return { octokit, calls };
}

const baseCommand: CanonicalCommand = {
  intent: "ship",
  surface: "literal",
  principal_login: "alice",
  pr: { owner: "acme", repo: "repo", number: 401, installation_id: 99 },
};

const eligibleResponse = {
  repository: {
    pullRequest: {
      state: "OPEN",
      merged: false,
      baseRefName: "main",
      baseRepository: { id: "repo-1" },
      headRepository: { id: "repo-1" },
      author: { login: "alice" },
    },
  },
};

const ineligibleClosedResponse = {
  repository: {
    pullRequest: {
      state: "CLOSED",
      merged: false,
      baseRefName: "main",
      baseRepository: { id: "repo-1" },
      headRepository: { id: "repo-1" },
      author: { login: "alice" },
    },
  },
};

function buildProbeResponse(opts: {
  readonly ready: boolean;
  readonly isDraft: boolean;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly mergeable?: "MERGEABLE" | "CONFLICTING";
}): unknown {
  const headSha = opts.headSha ?? "sha-head";
  const baseSha = opts.baseSha ?? "sha-base";
  // Verdict priority 1 (foreign-push detection) inspects the head
  // commit's author login. For "ready" cases we must attribute the head
  // commit to the bot itself so the priority-1 check passes through to
  // the merge-state ladder.
  const headAuthorLogin = opts.ready ? "chrisleekr-bot[bot]" : "alice";
  return {
    repository: {
      pullRequest: {
        number: 401,
        isDraft: opts.isDraft,
        state: "OPEN",
        merged: false,
        mergeable: opts.mergeable ?? "MERGEABLE",
        mergeStateStatus: opts.ready ? "CLEAN" : "BEHIND",
        reviewDecision: opts.ready ? "APPROVED" : "REVIEW_REQUIRED",
        baseRefName: "main",
        baseRefOid: baseSha,
        headRefName: "feat/x",
        headRefOid: headSha,
        author: { login: "alice" },
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: headSha,
                committedDate: new Date().toISOString(),
                author: {
                  user: { login: headAuthorLogin },
                  email: `${headAuthorLogin}@example.com`,
                },
                statusCheckRollup: opts.ready
                  ? { state: "SUCCESS", contexts: { nodes: [] } }
                  : { state: "PENDING", contexts: { nodes: [] } },
              },
            },
          ],
        },
        reviews: { nodes: [] },
      },
    },
  };
}

describe.skipIf(sql === null)("runShipFromCommand", () => {
  beforeAll(async () => {
    await requireSql().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS comment_cache CASCADE;
      DROP TABLE IF EXISTS target_cache CASCADE;
      DROP TABLE IF EXISTS chat_proposals CASCADE;
      DROP TABLE IF EXISTS ship_fix_attempts CASCADE;
      DROP TABLE IF EXISTS ship_continuations CASCADE;
      DROP TABLE IF EXISTS ship_iterations CASCADE;
      DROP TABLE IF EXISTS ship_intents CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    const { runMigrations } = await import("../../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    await requireSql().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS comment_cache CASCADE;
      DROP TABLE IF EXISTS target_cache CASCADE;
      DROP TABLE IF EXISTS chat_proposals CASCADE;
      DROP TABLE IF EXISTS ship_fix_attempts CASCADE;
      DROP TABLE IF EXISTS ship_continuations CASCADE;
      DROP TABLE IF EXISTS ship_iterations CASCADE;
      DROP TABLE IF EXISTS ship_intents CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await requireSql().close();
  });

  beforeEach(async () => {
    await requireSql().unsafe(
      `TRUNCATE ship_fix_attempts, ship_continuations, ship_iterations, ship_intents`,
    );
  });

  it("(b) ineligible PR (closed): no intent row, posts refusal comment", async () => {
    const { octokit, calls } = buildOctokit({ eligibilityResponse: ineligibleClosedResponse });
    await runShipFromCommand({ command: baseCommand, octokit });
    const rows: { count: bigint }[] =
      await requireSql()`SELECT COUNT(*)::bigint AS count FROM ship_intents`;
    expect(Number(rows[0]?.count ?? 0n)).toBe(0);
    expect(calls.createCommentCalls.length).toBe(1);
    const body = (calls.createCommentCalls[0] as { body: string }).body;
    expect(body).toContain("declined");
    expect(body).toContain("closed");
  });

  it("(c) re-trigger when an active session exists: no second row, posts already-in-progress reply", async () => {
    // First run: probe returns non-ready so the intent stays active.
    const first = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: false, isDraft: false }),
    });
    await runShipFromCommand({ command: baseCommand, octokit: first.octokit });

    // Second run: same PR — must reject.
    const second = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: false, isDraft: false }),
    });
    await runShipFromCommand({ command: baseCommand, octokit: second.octokit });

    const rows: { count: bigint }[] = await requireSql()`
      SELECT COUNT(*)::bigint AS count FROM ship_intents
       WHERE owner='acme' AND repo='repo' AND pr_number=401 AND status='active'
    `;
    expect(Number(rows[0]?.count ?? 0n)).toBe(1);
    const lastReply = second.calls.createCommentCalls.at(-1) as { body: string } | undefined;
    expect(lastReply?.body).toContain("already in progress");
  });

  it("(e) verdict=ready terminal: marks ready-for-review on draft, transitions to ready_awaiting_human_merge", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: true }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_1" } } },
      markReadyResponse: {
        markPullRequestReadyForReview: { pullRequest: { id: "PR_node_1", isDraft: false } },
      },
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string; terminal_blocker_category: string | null }[] = await requireSql()`
      SELECT status, terminal_blocker_category
        FROM ship_intents
       WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    expect(rows[0]?.terminal_blocker_category).toBeNull();

    const markReady = calls.graphqlCalls.find((c) => c.query.includes("mutation MarkReady"));
    expect(markReady).toBeDefined();

    expect(calls.updateCommentCalls.length).toBe(1);
    const updated = calls.updateCommentCalls[0] as { body: string };
    expect(updated.body).toContain("ready_awaiting_human_merge");
  });

  it("(e) verdict=ready on non-draft PR: skips markReadyForReview, still transitions terminal", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: false }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_2" } } },
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string }[] = await requireSql()`
      SELECT status FROM ship_intents WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    const markReady = calls.graphqlCalls.find((c) => c.query.includes("mutation MarkReady"));
    expect(markReady).toBeUndefined();
  });

  it("(e) markReadyForReview failure does NOT block transition — terminal still set, error surfaced in tracking comment", async () => {
    const { octokit, calls } = buildOctokit({
      eligibilityResponse: eligibleResponse,
      probeResponse: buildProbeResponse({ ready: true, isDraft: true }),
      prIdResponse: { repository: { pullRequest: { id: "PR_node_3" } } },
      throwOnGraphql: "mutation MarkReady",
    });

    await runShipFromCommand({ command: baseCommand, octokit });

    const rows: { status: string }[] = await requireSql()`
      SELECT status FROM ship_intents WHERE owner='acme' AND repo='repo' AND pr_number=401
    `;
    expect(rows[0]?.status).toBe("ready_awaiting_human_merge");
    const updated = calls.updateCommentCalls[0] as { body: string };
    expect(updated.body).toContain("markReadyForReview failed");
  });
});
