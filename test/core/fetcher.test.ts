import { describe, expect, it } from "bun:test";

import { fetchGitHubData, filterByTriggerTime } from "../../src/core/fetcher";
import type { BotContext } from "../../src/types";
import { makeBotContext, makeOctokit, makeSilentLogger } from "../factories";
import { expectToReject } from "../utils/assertions";

const TRIGGER = "2025-06-01T12:00:00Z";

/** Build a comment-shaped object for test clarity */
function item(
  createdAt: string,
  opts?: { updatedAt?: string; lastEditedAt?: string },
): { createdAt: string; updatedAt?: string; lastEditedAt?: string } {
  return {
    createdAt,
    updatedAt: opts?.updatedAt,
    lastEditedAt: opts?.lastEditedAt,
  };
}

describe("filterByTriggerTime", () => {
  describe("createdAt filtering", () => {
    it("keeps items created before the trigger time", () => {
      const items = [item("2025-06-01T11:59:59Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("removes items created exactly at the trigger time", () => {
      const items = [item("2025-06-01T12:00:00Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("removes items created after the trigger time", () => {
      const items = [item("2025-06-01T12:00:01Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });
  });

  describe("lastEditedAt filtering (TOCTOU protection)", () => {
    it("removes items edited at or after trigger, even if created before", () => {
      const items = [item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T12:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("removes items edited after the trigger time", () => {
      const items = [item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T13:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("keeps items edited before trigger time", () => {
      const items = [item("2025-06-01T10:00:00Z", { lastEditedAt: "2025-06-01T11:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("prefers lastEditedAt over updatedAt when both are present", () => {
      // lastEditedAt is before trigger, updatedAt is after — item must be kept.
      const items = [
        item("2025-06-01T10:00:00Z", {
          lastEditedAt: "2025-06-01T11:00:00Z",
          updatedAt: "2025-06-01T13:00:00Z",
        }),
      ];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });
  });

  describe("updatedAt fallback (when lastEditedAt is absent)", () => {
    it("removes items updated at or after trigger when lastEditedAt is absent", () => {
      const items = [item("2025-06-01T11:00:00Z", { updatedAt: "2025-06-01T12:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("keeps items with updatedAt before trigger when lastEditedAt is absent", () => {
      const items = [item("2025-06-01T10:00:00Z", { updatedAt: "2025-06-01T11:30:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      expect(filterByTriggerTime([], TRIGGER)).toHaveLength(0);
    });

    it("handles items with no updatedAt or lastEditedAt (created-only filter)", () => {
      const items = [item("2025-06-01T11:00:00Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("filters multiple items correctly", () => {
      const items = [
        item("2025-06-01T10:00:00Z"), // keep
        item("2025-06-01T12:00:01Z"), // remove — created after
        item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T12:30:00Z" }), // remove — edited after
        item("2025-06-01T09:00:00Z", { updatedAt: "2025-06-01T11:00:00Z" }), // keep
      ];
      const result = filterByTriggerTime(items, TRIGGER);
      expect(result).toHaveLength(2);
    });
  });
});

// ─── fetchGitHubData ───────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<BotContext> & { graphqlResponse?: unknown; graphqlError?: Error },
): BotContext {
  const { graphqlResponse, graphqlError, ...ctxOverrides } = overrides;
  const octokitOpts: { graphqlResponse?: unknown; graphqlError?: Error } = {};
  if (graphqlResponse !== undefined) octokitOpts.graphqlResponse = graphqlResponse;
  if (graphqlError !== undefined) octokitOpts.graphqlError = graphqlError;
  return makeBotContext({
    triggerTimestamp: "2025-06-01T12:00:00Z",
    triggerBody: "body",
    octokit: makeOctokit(octokitOpts),
    ...ctxOverrides,
  });
}

describe("fetchGitHubData — issue path", () => {
  it("returns parsed issue data from GraphQL response", async () => {
    const ctx = makeCtx({
      isPR: false,
      graphqlResponse: {
        repository: {
          issue: {
            title: "Bug report",
            body: "Steps to reproduce...",
            author: { login: "reporter" },
            createdAt: "2025-05-01T00:00:00Z",
            updatedAt: "2025-05-01T00:00:00Z",
            lastEditedAt: null,
            state: "OPEN",
            comments: {
              nodes: [
                {
                  body: "Me too",
                  author: { login: "alice" },
                  createdAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: false,
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);

    expect(result.title).toBe("Bug report");
    expect(result.body).toBe("Steps to reproduce...");
    expect(result.state).toBe("OPEN");
    expect(result.author).toBe("reporter");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.author).toBe("alice");
    expect(result.reviewComments).toEqual([]);
    expect(result.changedFiles).toEqual([]);
  });

  it("coerces null body to empty string", async () => {
    const ctx = makeCtx({
      isPR: false,
      graphqlResponse: {
        repository: {
          issue: {
            title: "No body",
            body: null,
            author: { login: "user" },
            createdAt: "2025-05-01T00:00:00Z",
            updatedAt: "2025-05-01T00:00:00Z",
            lastEditedAt: null,
            state: "OPEN",
            comments: { nodes: [] },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.body).toBe("");
  });

  it("filters out minimized comments", async () => {
    const ctx = makeCtx({
      isPR: false,
      graphqlResponse: {
        repository: {
          issue: {
            title: "Title",
            body: "Body",
            author: { login: "user" },
            createdAt: "2025-05-01T00:00:00Z",
            updatedAt: "2025-05-01T00:00:00Z",
            lastEditedAt: null,
            state: "OPEN",
            comments: {
              nodes: [
                {
                  body: "Visible",
                  author: { login: "alice" },
                  createdAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: false,
                },
                {
                  body: "Hidden",
                  author: { login: "bob" },
                  createdAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: true,
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toBe("Visible");
  });

  it("filters comments by trigger time (TOCTOU)", async () => {
    const ctx = makeCtx({
      isPR: false,
      triggerTimestamp: "2025-05-10T12:00:00Z",
      graphqlResponse: {
        repository: {
          issue: {
            title: "Title",
            body: "Body",
            author: { login: "user" },
            createdAt: "2025-05-01T00:00:00Z",
            updatedAt: "2025-05-01T00:00:00Z",
            lastEditedAt: null,
            state: "OPEN",
            comments: {
              nodes: [
                {
                  body: "Before trigger",
                  author: { login: "early" },
                  createdAt: "2025-05-05T00:00:00Z",
                  updatedAt: "2025-05-05T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: false,
                },
                {
                  body: "After trigger",
                  author: { login: "late" },
                  createdAt: "2025-05-15T00:00:00Z",
                  updatedAt: "2025-05-15T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: false,
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.author).toBe("early");
  });

  it("throws when issue is null (not found)", async () => {
    const ctx = makeCtx({
      isPR: false,
      entityNumber: 999,
      graphqlResponse: {
        repository: { issue: null },
      },
    });

    await expectToReject(fetchGitHubData(ctx), "Issue #999 not found");
  });
});

describe("fetchGitHubData — PR path", () => {
  const basePrResponse = {
    repository: {
      pullRequest: {
        title: "Add feature X",
        body: "PR description",
        author: { login: "dev" },
        baseRefName: "main",
        headRefName: "feat/x",
        headRefOid: "abc123",
        createdAt: "2025-05-01T00:00:00Z",
        updatedAt: "2025-05-01T00:00:00Z",
        lastEditedAt: null,
        additions: 100,
        deletions: 20,
        state: "OPEN",
        commits: { totalCount: 3 },
        files: {
          nodes: [
            {
              path: "src/a.ts",
              additions: 50,
              deletions: 10,
              changeType: "MODIFIED",
            },
            {
              path: "src/b.ts",
              additions: 50,
              deletions: 10,
              changeType: "ADDED",
            },
          ],
        },
        comments: { nodes: [] },
        reviews: { nodes: [] },
      },
    },
  };

  it("returns parsed PR data with branches and changed files", async () => {
    const ctx = makeCtx({ isPR: true, graphqlResponse: basePrResponse });
    const result = await fetchGitHubData(ctx);

    expect(result.title).toBe("Add feature X");
    expect(result.headBranch).toBe("feat/x");
    expect(result.baseBranch).toBe("main");
    expect(result.headSha).toBe("abc123");
    expect(result.changedFiles).toHaveLength(2);
    expect(result.changedFiles[0]?.filename).toBe("src/a.ts");
    expect(result.changedFiles[0]?.status).toBe("MODIFIED");
  });

  it("maps regular PR comments from the comments connection", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlResponse: {
        repository: {
          pullRequest: {
            ...basePrResponse.repository.pullRequest,
            comments: {
              nodes: [
                {
                  body: "General PR comment",
                  author: { login: "alice" },
                  createdAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  isMinimized: false,
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.author).toBe("alice");
    expect(result.comments[0]?.body).toBe("General PR comment");
  });

  it("extracts review comments from all reviews", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlResponse: {
        repository: {
          pullRequest: {
            ...basePrResponse.repository.pullRequest,
            reviews: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  body: "LGTM",
                  state: "APPROVED",
                  submittedAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  comments: {
                    nodes: [
                      {
                        body: "Fix this line",
                        author: { login: "reviewer1" },
                        createdAt: "2025-05-02T00:00:00Z",
                        updatedAt: "2025-05-02T00:00:00Z",
                        lastEditedAt: null,
                        isMinimized: false,
                        path: "src/a.ts",
                        line: 42,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.reviewComments).toHaveLength(1);
    expect(result.reviewComments[0]?.path).toBe("src/a.ts");
    expect(result.reviewComments[0]?.line).toBe(42);
  });

  it("omits line field when review comment has null line", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlResponse: {
        repository: {
          pullRequest: {
            ...basePrResponse.repository.pullRequest,
            reviews: {
              nodes: [
                {
                  author: { login: "reviewer" },
                  body: "",
                  state: "COMMENTED",
                  submittedAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  comments: {
                    nodes: [
                      {
                        body: "File-level comment",
                        author: { login: "reviewer" },
                        createdAt: "2025-05-02T00:00:00Z",
                        updatedAt: "2025-05-02T00:00:00Z",
                        lastEditedAt: null,
                        isMinimized: false,
                        path: "src/a.ts",
                        line: null,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.reviewComments).toHaveLength(1);
    // exactOptionalPropertyTypes: line must be omitted, not set to null/undefined
    expect("line" in (result.reviewComments[0] ?? {})).toBe(false);
  });

  it("filters minimized review comments", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlResponse: {
        repository: {
          pullRequest: {
            ...basePrResponse.repository.pullRequest,
            reviews: {
              nodes: [
                {
                  author: { login: "r" },
                  body: "",
                  state: "COMMENTED",
                  submittedAt: "2025-05-02T00:00:00Z",
                  updatedAt: "2025-05-02T00:00:00Z",
                  lastEditedAt: null,
                  comments: {
                    nodes: [
                      {
                        body: "Hidden",
                        author: { login: "r" },
                        createdAt: "2025-05-02T00:00:00Z",
                        updatedAt: "2025-05-02T00:00:00Z",
                        lastEditedAt: null,
                        isMinimized: true,
                        path: "a.ts",
                        line: 1,
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.reviewComments).toHaveLength(0);
  });

  it("coerces null PR body to empty string", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlResponse: {
        repository: {
          pullRequest: {
            ...basePrResponse.repository.pullRequest,
            body: null,
          },
        },
      },
    });

    const result = await fetchGitHubData(ctx);
    expect(result.body).toBe("");
  });

  it("throws when PR is null (not found)", async () => {
    const ctx = makeCtx({
      isPR: true,
      entityNumber: 999,
      graphqlResponse: {
        repository: { pullRequest: null },
      },
    });

    await expectToReject(fetchGitHubData(ctx), "PR #999 not found");
  });

  it("propagates GraphQL API errors", async () => {
    const ctx = makeCtx({
      isPR: true,
      graphqlError: new Error("GraphQL: Bad credentials"),
    });

    await expectToReject(fetchGitHubData(ctx), "Bad credentials");
  });
});

// ─── Pagination + safety-cap behaviour ─────────────────────────────────────

/**
 * Builds N issue-comment-shaped GraphQL nodes with sequential ISO timestamps.
 * `triggerOffset` is the index whose `createdAt` matches `triggerTime` exactly
 * — items below it are pre-trigger (kept by `filterByTriggerTime`), items at
 * or above are post-trigger (filtered out).
 */
function buildIssueComments(
  n: number,
  _triggerOffset: number,
): {
  body: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  lastEditedAt: null;
  isMinimized: boolean;
}[] {
  const start = Date.UTC(2025, 4, 1); // 2025-05-01
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(start + i * 60_000).toISOString(); // one comment per minute
    return {
      body: `comment-${String(i)}`,
      author: { login: `user-${String(i)}` },
      createdAt: ts,
      updatedAt: ts,
      lastEditedAt: null,
      isMinimized: false,
    };
  });
}

describe("fetchGitHubData — pagination merge", () => {
  it("merges paginated issue comments into FetchedData (length > 100)", async () => {
    const total = 250;
    // Trigger offset is 999 so every fixture comment is pre-trigger and
    // survives the TOCTOU filter — proves pagination merged correctly.
    const ctx = makeCtx({
      isPR: false,
      // Trigger far in the future so all 250 fixture comments survive.
      triggerTimestamp: new Date(Date.UTC(2099, 0, 1)).toISOString(),
      octokit: makeOctokit({
        graphqlPaginateResponses: {
          // Top-level issue query is matched by the `issue(number:` selection.
          "issue(number:": {
            repository: {
              issue: {
                title: "Long thread",
                body: "Lots of comments",
                author: { login: "reporter" },
                createdAt: "2025-04-30T00:00:00Z",
                updatedAt: "2025-04-30T00:00:00Z",
                lastEditedAt: null,
                state: "OPEN",
                comments: {
                  nodes: buildIssueComments(total, total),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments.length).toBe(total);
    expect(result.truncated).toBeUndefined();
  });

  it("filterByTriggerTime runs after the merge — newest pre-trigger items survive", async () => {
    // 250 comments, trigger at the 240th — items 0..239 must be kept and
    // 240..249 dropped. Critically: comment 239 (the newest pre-trigger
    // item) MUST be in the result. Under the old un-paginated fetcher
    // this was the failure mode the issue reported: GraphQL would return
    // only the oldest 100, so comment 239 would be silently lost.
    const total = 250;
    const triggerOffset = 240;
    const start = Date.UTC(2025, 4, 1);
    const triggerIso = new Date(start + triggerOffset * 60_000).toISOString();

    const ctx = makeCtx({
      isPR: false,
      triggerTimestamp: triggerIso,
      octokit: makeOctokit({
        graphqlPaginateResponses: {
          "issue(number:": {
            repository: {
              issue: {
                title: "T",
                body: "B",
                author: { login: "u" },
                createdAt: "2025-04-30T00:00:00Z",
                updatedAt: "2025-04-30T00:00:00Z",
                lastEditedAt: null,
                state: "OPEN",
                comments: {
                  nodes: buildIssueComments(total, triggerOffset),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments.length).toBe(triggerOffset);
    // comment at index 239 (the newest pre-trigger item) is preserved
    expect(result.comments[triggerOffset - 1]?.author).toBe(`user-${String(triggerOffset - 1)}`);
    // post-trigger comments are dropped — no comment from index 240 onwards
    const postTriggerKept = result.comments.some(
      (c) => c.author === `user-${String(triggerOffset)}`,
    );
    expect(postTriggerKept).toBe(false);
  });

  it("trips truncated.comments and warns when the safety cap fires", async () => {
    const log = makeSilentLogger();
    // Default cap is 500 — overshoot it by enough that the cap fires.
    const total = 600;
    const ctx = makeCtx({
      isPR: false,
      triggerTimestamp: new Date(Date.UTC(2099, 0, 1)).toISOString(),
      log,
      octokit: makeOctokit({
        graphqlPaginateResponses: {
          "issue(number:": {
            repository: {
              issue: {
                title: "T",
                body: "B",
                author: { login: "u" },
                createdAt: "2025-04-30T00:00:00Z",
                updatedAt: "2025-04-30T00:00:00Z",
                lastEditedAt: null,
                state: "OPEN",
                comments: {
                  nodes: buildIssueComments(total, total),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.truncated?.comments).toBe(true);
    // Cap default is 500 — the merged result should be exactly 500.
    expect(result.comments.length).toBe(500);
    // The cap MUST keep the newest items, not the oldest. Comments arrive
    // ASC by createdAt from the GraphQL connection, so dropping the head
    // (the regression this guards against) would silently lose the most
    // recent 100 comments — including, very likely, the trigger comment.
    // After the cap, the surviving range is users 100..599; user-0 must be
    // gone and user-599 must be present.
    expect(result.comments.some((c) => c.author === "user-0")).toBe(false);
    expect(result.comments.some((c) => c.author === "user-599")).toBe(true);
    expect(result.comments[0]?.author).toBe("user-100");
    expect(result.comments[result.comments.length - 1]?.author).toBe("user-599");
    // log.warn must have been called with the structured shape callers rely on.
    const warnCalls = log.warn.mock.calls as [Record<string, unknown>, string][];
    const capWarn = warnCalls.find((c) => c[0]["connection"] === "comments");
    expect(capWarn).toBeDefined();
    expect(capWarn?.[0]["fetched"]).toBe(total);
    expect(capWarn?.[0]["cap"]).toBe(500);
  });

  it("merges nested per-review comments via the follow-up paginate call", async () => {
    // First page (returned by PR_QUERY) carries 100 comments + hasNextPage=true.
    // The follow-up REVIEW_COMMENTS_QUERY returns the remaining 50.
    const reviewCommentsPage1 = Array.from({ length: 100 }, (_, i) => ({
      body: `inline-${String(i)}`,
      author: { login: "rev" },
      createdAt: "2025-05-02T00:00:00Z",
      updatedAt: "2025-05-02T00:00:00Z",
      lastEditedAt: null,
      isMinimized: false,
      path: `src/f${String(i)}.ts`,
      line: i + 1,
    }));
    const reviewCommentsPage2 = Array.from({ length: 50 }, (_, i) => ({
      body: `inline-${String(100 + i)}`,
      author: { login: "rev" },
      createdAt: "2025-05-02T00:00:00Z",
      updatedAt: "2025-05-02T00:00:00Z",
      lastEditedAt: null,
      isMinimized: false,
      path: `src/g${String(i)}.ts`,
      line: i + 1,
    }));

    const ctx = makeCtx({
      isPR: true,
      triggerTimestamp: new Date(Date.UTC(2099, 0, 1)).toISOString(),
      octokit: makeOctokit({
        graphqlPaginateResponses: {
          // Top-level PR query — hand back one review with a partial first
          // page of nested comments.
          "pullRequest(number:": {
            repository: {
              pullRequest: {
                title: "Big review",
                body: "PR",
                author: { login: "dev" },
                baseRefName: "main",
                headRefName: "feat/x",
                headRefOid: "sha",
                createdAt: "2025-05-01T00:00:00Z",
                updatedAt: "2025-05-01T00:00:00Z",
                lastEditedAt: null,
                additions: 0,
                deletions: 0,
                state: "OPEN",
                commits: { totalCount: 1 },
                files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                reviews: {
                  nodes: [
                    {
                      id: "REVIEW_NODE_ID_1",
                      author: { login: "rev" },
                      body: "",
                      state: "COMMENTED",
                      submittedAt: "2025-05-02T00:00:00Z",
                      updatedAt: "2025-05-02T00:00:00Z",
                      lastEditedAt: null,
                      comments: {
                        nodes: reviewCommentsPage1,
                        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
          // Follow-up paginate of the nested review-comments connection —
          // matched by the `... on PullRequestReview` selection unique to
          // REVIEW_COMMENTS_QUERY.
          PullRequestReview: {
            node: {
              comments: {
                nodes: reviewCommentsPage2,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.reviewComments.length).toBe(150);
    // First-page item present
    expect(result.reviewComments.some((c) => c.body === "inline-0")).toBe(true);
    // Second-page item present — proves the follow-up paginate call ran
    expect(result.reviewComments.some((c) => c.body === "inline-149")).toBe(true);
  });
});

describe("fetchGitHubData — real paginate-graphql plugin contract", () => {
  // These tests wire the actual `@octokit/plugin-paginate-graphql` against a
  // stubbed `octokit.graphql` so the plugin's contract is enforced — the
  // canned-merged-response path used elsewhere cannot tell a working
  // implementation apart from one that violates the cursor-name or
  // single-pageInfo invariants. If the queries in src/core/fetcher.ts ever
  // regress on either invariant, the plugin throws here.
  function commentsPage(
    n: number,
    startIndex: number,
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
  ): {
    repository: {
      issue: {
        title: string;
        body: string;
        author: { login: string };
        createdAt: string;
        updatedAt: string;
        lastEditedAt: null;
        state: string;
        comments: {
          nodes: ReturnType<typeof buildIssueComments>;
          pageInfo: typeof pageInfo;
        };
      };
    };
  } {
    const all = buildIssueComments(startIndex + n, startIndex + n);
    return {
      repository: {
        issue: {
          title: "T",
          body: "B",
          author: { login: "u" },
          createdAt: "2025-04-30T00:00:00Z",
          updatedAt: "2025-04-30T00:00:00Z",
          lastEditedAt: null,
          state: "OPEN",
          comments: {
            nodes: all.slice(startIndex, startIndex + n),
            pageInfo,
          },
        },
      },
    };
  }

  it("walks issue comments across two real pages via $cursor", async () => {
    // Page 1 returns 100 comments + hasNextPage=true; page 2 returns 50.
    // The real plugin will only advance the cursor if the query declares
    // `$cursor` (renaming it to `$afterComments` would deadlock on an
    // unchanging cursor and throw `MissingCursorChange`).
    const ctx = makeBotContext({
      isPR: false,
      triggerTimestamp: new Date(Date.UTC(2099, 0, 1)).toISOString(),
      octokit: makeOctokit({
        useRealPaginatePlugin: true,
        graphqlPagesByQuery: {
          "issue(number:": [
            commentsPage(100, 0, { hasNextPage: true, endCursor: "cursor-1" }),
            commentsPage(50, 100, { hasNextPage: false, endCursor: null }),
          ],
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.comments.length).toBe(150);
    // Page-1 first item AND page-2 last item must both be present —
    // proves both pages were merged.
    expect(result.comments[0]?.author).toBe("user-0");
    expect(result.comments[149]?.author).toBe("user-149");
  });

  it("walks PR connections (files/comments/reviews) independently across real pages", async () => {
    // Three independent paginate calls each chain their own `$cursor`.
    // If the queries ever collapse multiple pageInfo blocks into one,
    // the second connection silently truncates to page 1 — this test
    // surfaces that.
    const filesP1 = Array.from({ length: 100 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      additions: 1,
      deletions: 0,
      changeType: "MODIFIED",
    }));
    const filesP2 = Array.from({ length: 30 }, (_, i) => ({
      path: `f${String(100 + i)}.ts`,
      additions: 1,
      deletions: 0,
      changeType: "ADDED",
    }));
    const commentsP1 = Array.from({ length: 100 }, (_, i) => ({
      body: `pr-comment-${String(i)}`,
      author: { login: `u${String(i)}` },
      createdAt: "2025-05-01T00:00:00Z",
      updatedAt: "2025-05-01T00:00:00Z",
      lastEditedAt: null,
      isMinimized: false,
    }));
    const commentsP2 = Array.from({ length: 20 }, (_, i) => ({
      body: `pr-comment-${String(100 + i)}`,
      author: { login: `u${String(100 + i)}` },
      createdAt: "2025-05-01T00:00:00Z",
      updatedAt: "2025-05-01T00:00:00Z",
      lastEditedAt: null,
      isMinimized: false,
    }));

    const prBaseP1 = {
      repository: {
        pullRequest: {
          title: "Big PR",
          body: "PR body",
          author: { login: "dev" },
          baseRefName: "main",
          headRefName: "feat/x",
          headRefOid: "sha",
          createdAt: "2025-05-01T00:00:00Z",
          updatedAt: "2025-05-01T00:00:00Z",
          lastEditedAt: null,
          additions: 0,
          deletions: 0,
          state: "OPEN",
          commits: { totalCount: 1 },
          files: { nodes: filesP1, pageInfo: { hasNextPage: true, endCursor: "files-1" } },
        },
      },
    };
    const prBaseP2 = {
      repository: {
        pullRequest: {
          title: "Big PR",
          body: "PR body",
          author: { login: "dev" },
          baseRefName: "main",
          headRefName: "feat/x",
          headRefOid: "sha",
          createdAt: "2025-05-01T00:00:00Z",
          updatedAt: "2025-05-01T00:00:00Z",
          lastEditedAt: null,
          additions: 0,
          deletions: 0,
          state: "OPEN",
          commits: { totalCount: 1 },
          files: { nodes: filesP2, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    };

    const ctx = makeBotContext({
      isPR: true,
      triggerTimestamp: new Date(Date.UTC(2099, 0, 1)).toISOString(),
      octokit: makeOctokit({
        useRealPaginatePlugin: true,
        graphqlPagesByQuery: {
          // PR_FIRST_QUERY — `commits(first: 100)` is unique to it.
          "commits(first: 100)": [prBaseP1, prBaseP2],
          // PR_COMMENTS_QUERY — uses `comments(first: 100, after: $cursor)`.
          "comments(first: 100, after: $cursor)": [
            {
              repository: {
                pullRequest: {
                  comments: {
                    nodes: commentsP1,
                    pageInfo: { hasNextPage: true, endCursor: "comments-1" },
                  },
                },
              },
            },
            {
              repository: {
                pullRequest: {
                  comments: {
                    nodes: commentsP2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          ],
          // PR_REVIEWS_QUERY — single page, empty.
          "reviews(first: 100, after: $cursor)": [
            {
              repository: {
                pullRequest: {
                  reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          ],
        },
      }),
    });

    const result = await fetchGitHubData(ctx);
    expect(result.changedFiles.length).toBe(130);
    expect(result.comments.length).toBe(120);
    // Both page boundaries crossed — last item of each connection survived.
    expect(result.changedFiles[129]?.filename).toBe("f129.ts");
    expect(result.comments[119]?.body).toBe("pr-comment-119");
  });
});

describe("FetchedData.truncated → prompt banner", () => {
  // The prompt builder is exercised by its own test file; this assertion
  // pins the contract that fetcher tests rely on: a truncated payload
  // produces a non-empty banner string the agent will see.
  it("buildPrompt includes a WARNING line when fetcher capped a connection", async () => {
    const { buildPrompt } = await import("../../src/core/prompt-builder");
    const ctx = makeBotContext({
      isPR: true,
      headBranch: "feat/x",
      baseBranch: "main",
    });
    const data = {
      title: "T",
      body: "",
      state: "OPEN",
      author: "a",
      comments: [],
      reviewComments: [],
      changedFiles: [],
      headBranch: "feat/x",
      baseBranch: "main",
      headSha: "sha",
      truncated: { comments: true, reviewComments: true },
    };
    const prompt = buildPrompt(ctx, data, undefined);
    expect(prompt).toContain("WARNING: pre-fetched context is incomplete");
    expect(prompt).toContain("comments");
    expect(prompt).toContain("review comments");
  });
});
