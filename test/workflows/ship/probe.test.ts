/**
 * Tests for src/workflows/ship/probe.ts. Mocks octokit.graphql and the
 * sleep function for determinism per Constitution V (no real API).
 */

import { describe, expect, it } from "bun:test";

import { runProbe } from "../../../src/workflows/ship/probe";
import type { ProbeResponseShape } from "../../../src/workflows/ship/verdict";

const HEAD_SHA = "h".repeat(40);
const BASE_SHA = "b".repeat(40);

function readyResponse(mergeable: "MERGEABLE" | null = "MERGEABLE"): ProbeResponseShape {
  return {
    repository: {
      pullRequest: {
        number: 1,
        isDraft: false,
        state: "OPEN",
        merged: false,
        mergeable,
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        baseRefName: "main",
        baseRefOid: BASE_SHA,
        headRefName: "feat/x",
        headRefOid: HEAD_SHA,
        author: { login: "alice" },
        reviewThreads: { nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: HEAD_SHA,
                committedDate: new Date().toISOString(),
                author: { user: { login: "chrisleekr-bot" }, email: null },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          ],
        },
      },
    },
  };
}

describe("runProbe", () => {
  it("returns ready verdict on the first call when mergeable=MERGEABLE", async () => {
    const calls: number[] = [];
    const result = await runProbe({
      octokit: {
        graphql: () => {
          calls.push(1);
          return Promise.resolve(readyResponse()) as never;
        },
      } as never,
      owner: "o",
      repo: "r",
      pr_number: 1,
      botAppLogin: "chrisleekr-bot",
      botPushedShas: new Set([HEAD_SHA]),
      sleep: () => Promise.resolve(),
    });
    expect(result.verdict.ready).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("returns mergeable_pending after backoff exhausted (FR-021)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await runProbe({
      octokit: {
        graphql: () => {
          calls += 1;
          return Promise.resolve(readyResponse(null)) as never;
        },
      } as never,
      owner: "o",
      repo: "r",
      pr_number: 1,
      botAppLogin: "chrisleekr-bot",
      botPushedShas: new Set([HEAD_SHA]),
      mergeableBackoffMs: [10, 20, 30],
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.verdict.ready).toBe(false);
    if (!result.verdict.ready) expect(result.verdict.reason).toBe("mergeable_pending");
    expect(calls).toBe(4); // initial + 3 retries
    expect(sleeps).toEqual([10, 20, 30]);
  });

  it("recovers when mergeable transitions from null to MERGEABLE mid-backoff", async () => {
    const responses = [readyResponse(null), readyResponse(null), readyResponse("MERGEABLE")];
    let i = 0;
    const result = await runProbe({
      octokit: {
        graphql: () => Promise.resolve(responses[i++]) as never,
      } as never,
      owner: "o",
      repo: "r",
      pr_number: 1,
      botAppLogin: "chrisleekr-bot",
      botPushedShas: new Set([HEAD_SHA]),
      mergeableBackoffMs: [5, 5, 5, 5, 5],
      sleep: () => Promise.resolve(),
    });
    expect(result.verdict.ready).toBe(true);
    expect(i).toBe(3);
  });
});
