/**
 * Unit tests for the reactions helper. Covers the two endpoint dispatches
 * (issue comment vs PR review comment) and the swallowed-error contract,
 * a failing reactions API call must never bubble up because reactions are
 * a cosmetic UX layer on top of the workflow.
 */

import { describe, expect, it, mock } from "bun:test";
import type pino from "pino";

import { addReaction } from "../../src/utils/reactions";

function silentLogger(): pino.Logger {
  return {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger(),
  } as unknown as pino.Logger;
}

describe("addReaction", () => {
  it("routes issue_comment through createForIssueComment", async () => {
    const create = mock(() => Promise.resolve({}));
    const octokit = {
      rest: {
        reactions: {
          createForIssueComment: create,
          createForPullRequestReviewComment: mock(() => {
            throw new Error("wrong endpoint called");
          }),
        },
      },
    } as never;

    await addReaction({
      octokit,
      logger: silentLogger(),
      owner: "acme",
      repo: "repo",
      commentId: 42,
      eventType: "issue_comment",
      content: "eyes",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({
      owner: "acme",
      repo: "repo",
      comment_id: 42,
      content: "eyes",
    });
  });

  it("routes pull_request_review_comment through createForPullRequestReviewComment", async () => {
    const create = mock(() => Promise.resolve({}));
    const octokit = {
      rest: {
        reactions: {
          createForIssueComment: mock(() => {
            throw new Error("wrong endpoint called");
          }),
          createForPullRequestReviewComment: create,
        },
      },
    } as never;

    await addReaction({
      octokit,
      logger: silentLogger(),
      owner: "acme",
      repo: "repo",
      commentId: 99,
      eventType: "pull_request_review_comment",
      content: "rocket",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({
      owner: "acme",
      repo: "repo",
      comment_id: 99,
      content: "rocket",
    });
  });

  it("swallows API errors so a missing reactions:write scope can't break the workflow", async () => {
    const octokit = {
      rest: {
        reactions: {
          createForIssueComment: mock(() =>
            Promise.reject(new Error("403 Resource not accessible by integration")),
          ),
          createForPullRequestReviewComment: mock(() => Promise.resolve({})),
        },
      },
    } as never;

    let warned: { msg: string; bindings: unknown } | null = null;
    const log = {
      ...silentLogger(),
      warn: ((bindings: unknown, msg: string): undefined => {
        warned = { bindings, msg };
        return undefined;
      }) as never,
    } as unknown as pino.Logger;

    // Should NOT throw, the assertion is the absence of a thrown error and
    // the presence of the warn-level log entry.
    await addReaction({
      octokit,
      logger: log,
      owner: "acme",
      repo: "repo",
      commentId: 7,
      eventType: "issue_comment",
      content: "confused",
    });

    expect(warned).not.toBeNull();
    expect(warned?.msg).toBe("Failed to add reaction, continuing without it");
  });
});
