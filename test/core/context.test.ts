import type { IssueCommentEvent, PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import { describe, expect, it } from "bun:test";
import type { Octokit } from "octokit";

import { parseIssueCommentEvent, parseReviewCommentEvent } from "../../src/core/context";

// Minimal mock Octokit — context parsing doesn't call any API methods
const mockOctokit = {} as Octokit;

// Minimal payload factories matching the fields context.ts actually reads
function makeIssueCommentPayload(overrides?: Partial<IssueCommentEvent>): IssueCommentEvent {
  return {
    action: "created",
    issue: {
      number: 42,
      pull_request: undefined,
      ...overrides?.issue,
    },
    comment: {
      id: 100,
      user: { login: "testuser" },
      created_at: "2025-06-01T12:00:00Z",
      body: "@chrisleekr-bot review this",
      ...overrides?.comment,
    },
    repository: {
      owner: { login: "myorg" },
      name: "myrepo",
      default_branch: "main",
      ...overrides?.repository,
    },
    ...overrides,
  } as unknown as IssueCommentEvent;
}

function makeReviewCommentPayload(
  overrides?: Partial<PullRequestReviewCommentEvent>,
): PullRequestReviewCommentEvent {
  return {
    action: "created",
    pull_request: {
      number: 7,
      head: { ref: "feat/test" },
      base: { ref: "main" },
      ...overrides?.pull_request,
    },
    comment: {
      id: 200,
      user: { login: "reviewer" },
      created_at: "2025-06-02T08:00:00Z",
      body: "@chrisleekr-bot fix this",
      ...overrides?.comment,
    },
    repository: {
      owner: { login: "org" },
      name: "repo",
      default_branch: "main",
      ...overrides?.repository,
    },
    ...overrides,
  } as unknown as PullRequestReviewCommentEvent;
}

describe("parseIssueCommentEvent", () => {
  it("parses basic issue comment fields", () => {
    const payload = makeIssueCommentPayload();
    const ctx = parseIssueCommentEvent(payload, mockOctokit, "delivery-1");

    expect(ctx.owner).toBe("myorg");
    expect(ctx.repo).toBe("myrepo");
    expect(ctx.entityNumber).toBe(42);
    expect(ctx.isPR).toBe(false);
    expect(ctx.eventName).toBe("issue_comment");
    expect(ctx.triggerUsername).toBe("testuser");
    expect(ctx.triggerTimestamp).toBe("2025-06-01T12:00:00Z");
    expect(ctx.triggerBody).toBe("@chrisleekr-bot review this");
    expect(ctx.commentId).toBe(100);
    expect(ctx.deliveryId).toBe("delivery-1");
    expect(ctx.defaultBranch).toBe("main");
  });

  it("detects PR from pull_request field on issue", () => {
    const payload = makeIssueCommentPayload({
      issue: { number: 5, pull_request: { url: "https://..." } },
    } as Partial<IssueCommentEvent>);
    const ctx = parseIssueCommentEvent(payload, mockOctokit, "delivery-2");

    expect(ctx.isPR).toBe(true);
    expect(ctx.entityNumber).toBe(5);
  });

  it("does not set headBranch or baseBranch (populated later by fetcher)", () => {
    const payload = makeIssueCommentPayload();
    const ctx = parseIssueCommentEvent(payload, mockOctokit, "delivery-3");

    expect(ctx.headBranch).toBeUndefined();
    expect(ctx.baseBranch).toBeUndefined();
  });
});

describe("parseReviewCommentEvent", () => {
  it("parses review comment fields", () => {
    const payload = makeReviewCommentPayload();
    const ctx = parseReviewCommentEvent(payload, mockOctokit, "delivery-4");

    expect(ctx.owner).toBe("org");
    expect(ctx.repo).toBe("repo");
    expect(ctx.entityNumber).toBe(7);
    expect(ctx.isPR).toBe(true);
    expect(ctx.eventName).toBe("pull_request_review_comment");
    expect(ctx.triggerUsername).toBe("reviewer");
    expect(ctx.triggerTimestamp).toBe("2025-06-02T08:00:00Z");
    expect(ctx.triggerBody).toBe("@chrisleekr-bot fix this");
    expect(ctx.commentId).toBe(200);
    expect(ctx.deliveryId).toBe("delivery-4");
  });

  it("populates head and base branch from PR payload", () => {
    const payload = makeReviewCommentPayload();
    const ctx = parseReviewCommentEvent(payload, mockOctokit, "delivery-5");

    expect(ctx.headBranch).toBe("feat/test");
    expect(ctx.baseBranch).toBe("main");
  });
});
