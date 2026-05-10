/**
 * T036b: manual-push detection. Foreign-push detection lives in two places:
 *   1. webhook-reactor.fanOut on `pull_request.synchronize`: terminates
 *      with `human_took_over` + `manual-push-detected` when the head SHA
 *      changed and the pusher is not the bot.
 *   2. lifecycle-commands.runLifecycleCommand("resume"): same check on
 *      resume.
 *
 * Both are exercised by other test files; this file pins the contract
 * via the verdict module's foreign-push check (priority 1).
 */

import { describe, expect, it } from "bun:test";

import { computeVerdict, type ProbeResponseShape } from "../../../src/workflows/ship/verdict";

const BOT_LOGIN = "chrisleekr-bot[bot]";

function probeWithHeadAuthor(authorLogin: string | null): ProbeResponseShape {
  return {
    repository: {
      pullRequest: {
        number: 1,
        isDraft: false,
        state: "OPEN",
        merged: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        baseRefName: "main",
        baseRefOid: "base-1",
        headRefName: "feat",
        headRefOid: "head-1",
        author: { login: "alice" },
        reviewThreads: { totalCount: 0, nodes: [] },
        commits: {
          nodes: [
            {
              commit: {
                oid: "head-1",
                committedDate: new Date().toISOString(),
                author: {
                  user: authorLogin === null ? null : { login: authorLogin },
                  email: null,
                },
                statusCheckRollup: { contexts: { nodes: [] } },
              },
            },
          ],
        },
      },
    },
  } as unknown as ProbeResponseShape;
}

describe("manual-push detection (T036b)", () => {
  it("verdict is human_took_over when head commit author is a non-bot", () => {
    const v = computeVerdict({
      response: probeWithHeadAuthor("alice"),
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(false);
    if (!v.ready) expect(v.reason).toBe("human_took_over");
  });

  it("verdict is human_took_over when head commit author is null/<unknown>", () => {
    const v = computeVerdict({
      response: probeWithHeadAuthor(null),
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(false);
    if (!v.ready) expect(v.reason).toBe("human_took_over");
  });

  it("bot author on the head SHA passes the priority-1 check", () => {
    const v = computeVerdict({
      response: probeWithHeadAuthor(BOT_LOGIN),
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(true);
  });

  it("non-bot author on a SHA the bot pushed also passes (botPushedShas escape hatch)", () => {
    const v = computeVerdict({
      response: probeWithHeadAuthor("alice"),
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(["head-1"]),
    });
    expect(v.ready).toBe(true);
  });
});
