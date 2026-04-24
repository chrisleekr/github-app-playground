import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { dispatchByIntent } from "../../workflows/dispatcher";
import { isOwnerAllowed } from "../authorize";

/**
 * Handler for pull_request_review_comment.created events.
 *
 * Trigger detection → owner allowlist → `dispatchByIntent` (T039). Review
 * comments always target a PR.
 */
export function handleReviewComment(
  octokit: Octokit,
  payload: PullRequestReviewCommentEvent,
  deliveryId: string,
): void {
  if (payload.action !== "created") return;
  if (payload.comment.user.type === "Bot") return;
  if (!containsTrigger(payload.comment.body)) return;

  const senderLogin = payload.comment.user.login;
  const log = logger.child({
    deliveryId,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
    senderLogin,
  });

  log.info("Trigger detected in review_comment — routing via intent classifier");

  const auth = isOwnerAllowed(payload.repository.owner.login, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "review_comment dropped — owner not allowlisted");
    return;
  }

  void dispatchByIntent({
    octokit,
    logger: log,
    commentBody: payload.comment.body,
    target: {
      type: "pr",
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      number: payload.pull_request.number,
    },
    senderLogin,
    deliveryId,
  }).catch((err: unknown) => {
    log.error({ err }, "dispatchByIntent threw for review_comment");
  });
}
