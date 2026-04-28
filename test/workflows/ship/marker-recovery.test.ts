/**
 * T047: tracking-comment marker recovery. Cached comment_id 404 →
 * fallback marker scan finds the canonical comment.
 */

import { describe, expect, it } from "bun:test";
import type { Octokit } from "octokit";

import {
  buildIntentMarker,
  findTrackingCommentByMarker,
} from "../../../src/workflows/ship/tracking-comment";

const INTENT_ID = "abc123";
const MARKER = buildIntentMarker(INTENT_ID);

function makeOctokit(pages: { id: number; body: string | null }[][]): Octokit {
  let call = 0;
  return {
    rest: {
      issues: {
        listComments: () => {
          const data = pages[call] ?? [];
          call += 1;
          return Promise.resolve({ data });
        },
      },
    },
  } as unknown as Octokit;
}

describe("tracking-comment marker recovery (T047)", () => {
  it("returns null when no comment carries the marker (single page)", async () => {
    const id = await findTrackingCommentByMarker({
      octokit: makeOctokit([[{ id: 1, body: "unrelated" }]]),
      owner: "acme",
      repo: "repo",
      issue_number: 1,
      intent_id: INTENT_ID,
    });
    expect(id).toBeNull();
  });

  it("finds the marker in the first page", async () => {
    const id = await findTrackingCommentByMarker({
      octokit: makeOctokit([
        [
          { id: 1, body: "noise" },
          { id: 42, body: `${MARKER}\nbody` },
        ],
      ]),
      owner: "acme",
      repo: "repo",
      issue_number: 1,
      intent_id: INTENT_ID,
    });
    expect(id).toBe(42);
  });

  it("walks up to 3 pages of 100 looking for the marker", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "x" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 200 + i, body: "y" }));
    const page3 = [{ id: 999, body: `lots of stuff\n${MARKER}\n` }];
    const id = await findTrackingCommentByMarker({
      octokit: makeOctokit([page1, page2, page3]),
      owner: "acme",
      repo: "repo",
      issue_number: 1,
      intent_id: INTENT_ID,
    });
    expect(id).toBe(999);
  });

  it("buildIntentMarker is deterministic and contains the intent id", () => {
    const marker = buildIntentMarker(INTENT_ID);
    expect(marker).toContain(INTENT_ID);
    expect(marker).toBe(buildIntentMarker(INTENT_ID));
  });
});
