import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { parseReviewCommentEvent } from "../../core/context";
import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { processRequest } from "../router";

/**
 * Handler for pull_request_review_comment.created events.
 * Checks for trigger phrase, then dispatches async processing.
 */
export function handleReviewComment(
  octokit: Octokit,
  payload: PullRequestReviewCommentEvent,
  deliveryId: string,
): void {
  // Only process new review comments
  if (payload.action !== "created") return;

  // Skip bot comments
  if (payload.comment.user.type === "Bot") return;

  // Check for trigger phrase
  if (!containsTrigger(payload.comment.body)) return;

  logger.info(
    { deliveryId, owner: payload.repository.owner.login, repo: payload.repository.name },
    "Trigger detected in review_comment",
  );

  const ctx = parseReviewCommentEvent(payload, octokit, deliveryId);

  // Fire-and-forget
  processRequest(ctx).catch((err) => {
    ctx.log.error({ err }, "Async processing failed for review_comment");
  });
}
