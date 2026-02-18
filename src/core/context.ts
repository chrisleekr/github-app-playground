import type { IssueCommentEvent, PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { createChildLogger } from "../logger";
import type { BotContext } from "../types";

/**
 * Parse an issue_comment webhook payload into a unified BotContext.
 * Handles both PR comments (issue with pull_request field) and issue comments.
 *
 * Ported from claude-code-action's src/github/context.ts
 */
export function parseIssueCommentEvent(
  payload: IssueCommentEvent,
  octokit: Octokit,
  deliveryId: string,
): BotContext {
  const repo = payload.repository;
  const isPR = !!payload.issue.pull_request;

  const log = createChildLogger({
    deliveryId,
    owner: repo.owner.login,
    repo: repo.name,
    entityNumber: payload.issue.number,
  });

  return {
    owner: repo.owner.login,
    repo: repo.name,
    entityNumber: payload.issue.number,
    isPR,
    eventName: "issue_comment",
    triggerUsername: payload.comment.user.login,
    triggerTimestamp: payload.comment.created_at,
    triggerBody: payload.comment.body,
    commentId: payload.comment.id,
    deliveryId,
    // PR head/base branches are not in issue_comment payload;
    // they will be populated by the fetcher via GraphQL.
    // Omitted here intentionally (exactOptionalPropertyTypes forbids explicit undefined).
    defaultBranch: repo.default_branch,
    octokit,
    log,
  };
}

/**
 * Parse a pull_request_review_comment webhook payload into a unified BotContext.
 */
export function parseReviewCommentEvent(
  payload: PullRequestReviewCommentEvent,
  octokit: Octokit,
  deliveryId: string,
): BotContext {
  const repo = payload.repository;

  const log = createChildLogger({
    deliveryId,
    owner: repo.owner.login,
    repo: repo.name,
    entityNumber: payload.pull_request.number,
  });

  return {
    owner: repo.owner.login,
    repo: repo.name,
    entityNumber: payload.pull_request.number,
    isPR: true,
    eventName: "pull_request_review_comment",
    triggerUsername: payload.comment.user.login,
    triggerTimestamp: payload.comment.created_at,
    triggerBody: payload.comment.body,
    commentId: payload.comment.id,
    deliveryId,
    headBranch: payload.pull_request.head.ref,
    baseBranch: payload.pull_request.base.ref,
    defaultBranch: repo.default_branch,
    octokit,
    log,
  };
}
