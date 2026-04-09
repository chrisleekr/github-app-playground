import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import { fetchGitHubData, filterByTriggerTime } from "../../src/core/fetcher";
import type { BotContext } from "../../src/types";
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

function makeLog(): BotContext["log"] {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child(): BotContext["log"] {
      return this as unknown as BotContext["log"];
    },
  } as unknown as BotContext["log"];
}

function makeCtx(
  overrides: Partial<BotContext> & { graphqlResponse?: unknown; graphqlError?: Error },
): BotContext {
  const { graphqlResponse, graphqlError, ...ctxOverrides } = overrides;
  const graphqlFn = mock(() => {
    if (graphqlError !== undefined) {
      return Promise.reject(graphqlError);
    }
    return Promise.resolve(graphqlResponse);
  });

  const octokit = {
    graphql: graphqlFn,
  } as unknown as Octokit;

  return {
    owner: "myorg",
    repo: "myrepo",
    entityNumber: 42,
    isPR: false,
    eventName: "issue_comment" as const,
    triggerUsername: "tester",
    triggerTimestamp: "2025-06-01T12:00:00Z",
    triggerBody: "body",
    commentId: 1,
    deliveryId: "test-delivery",
    defaultBranch: "main",
    octokit,
    log: makeLog(),
    ...ctxOverrides,
  };
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
