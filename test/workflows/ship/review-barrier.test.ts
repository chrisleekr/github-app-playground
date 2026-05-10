/**
 * Tests for `src/workflows/ship/review-barrier.ts` (T034).
 * Pure function: no DB, no network.
 */

import { describe, expect, it } from "bun:test";

import {
  type BarrierProbeShape,
  shouldDeferOnReviewLatency,
} from "../../../src/workflows/ship/review-barrier";

const HEAD_SHA = "sha-head-1";
const BOT_LOGIN = "chrisleekr-bot[bot]";

function buildProbe(opts: {
  readonly reviews: { authorLogin: string | null; commitOid: string | null }[];
  readonly committedDateMsAgo: number;
}): BarrierProbeShape {
  const committedDate = new Date(Date.now() - opts.committedDateMsAgo).toISOString();
  return {
    repository: {
      pullRequest: {
        headRefOid: HEAD_SHA,
        commits: { nodes: [{ commit: { committedDate } }] },
        reviews: {
          nodes: opts.reviews.map((r) => ({
            author: r.authorLogin === null ? null : { login: r.authorLogin },
            commit: r.commitOid === null ? null : { oid: r.commitOid },
          })),
        },
      },
    },
  };
}

describe("shouldDeferOnReviewLatency", () => {
  it("defers when no qualifying review on current head AND safety margin not elapsed", () => {
    const probe = buildProbe({ reviews: [], committedDateMsAgo: 1000 });
    expect(
      shouldDeferOnReviewLatency({
        probeResponse: probe,
        ourAppLogin: BOT_LOGIN,
        safetyMarginMs: 1_200_000,
      }),
    ).toBe(true);
  });

  it("passes when a non-bot review is on the current head SHA", () => {
    const probe = buildProbe({
      reviews: [{ authorLogin: "alice", commitOid: HEAD_SHA }],
      committedDateMsAgo: 1000,
    });
    expect(
      shouldDeferOnReviewLatency({
        probeResponse: probe,
        ourAppLogin: BOT_LOGIN,
        safetyMarginMs: 1_200_000,
      }),
    ).toBe(false);
  });

  it("passes when safety margin elapsed since last push regardless of review activity", () => {
    const probe = buildProbe({ reviews: [], committedDateMsAgo: 2_000_000 });
    expect(
      shouldDeferOnReviewLatency({
        probeResponse: probe,
        ourAppLogin: BOT_LOGIN,
        safetyMarginMs: 1_200_000,
      }),
    ).toBe(false);
  });

  it("excludes the App's own login from non-bot detection", () => {
    const probe = buildProbe({
      reviews: [{ authorLogin: BOT_LOGIN, commitOid: HEAD_SHA }],
      committedDateMsAgo: 1000,
    });
    expect(
      shouldDeferOnReviewLatency({
        probeResponse: probe,
        ourAppLogin: BOT_LOGIN,
        safetyMarginMs: 1_200_000,
      }),
    ).toBe(true);
  });

  it("ignores reviews on stale head SHAs", () => {
    const probe = buildProbe({
      reviews: [{ authorLogin: "alice", commitOid: "stale-sha" }],
      committedDateMsAgo: 1000,
    });
    expect(
      shouldDeferOnReviewLatency({
        probeResponse: probe,
        ourAppLogin: BOT_LOGIN,
        safetyMarginMs: 1_200_000,
      }),
    ).toBe(true);
  });
});
