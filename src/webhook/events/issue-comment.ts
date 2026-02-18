import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { parseIssueCommentEvent } from "../../core/context";
import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { processRequest } from "../router";

/**
 * Handler for issue_comment.created events.
 * Checks for trigger phrase, then dispatches async processing.
 */
export function handleIssueComment(
  octokit: Octokit,
  payload: IssueCommentEvent,
  deliveryId: string,
): void {
  // Only process new comments (not edits/deletions)
  if (payload.action !== "created") return;

  // Skip bot comments to avoid self-triggering loops
  if (payload.comment.user.type === "Bot") return;

  // Check for trigger phrase
  if (!containsTrigger(payload.comment.body)) return;

  logger.info(
    { deliveryId, owner: payload.repository.owner.login, repo: payload.repository.name },
    "Trigger detected in issue_comment",
  );

  const ctx = parseIssueCommentEvent(payload, octokit, deliveryId);

  // Fire-and-forget: don't await (webhook must respond < 10s)
  processRequest(ctx).catch((err) => {
    ctx.log.error({ err }, "Async processing failed for issue_comment");
  });
}
