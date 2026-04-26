import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { addReaction } from "../../utils/reactions";
import { dispatchByIntent } from "../../workflows/dispatcher";
import { isOwnerAllowed } from "../authorize";

/**
 * Handler for issue_comment.created events.
 *
 * When a comment mentions `@chrisleekr-bot`, the body is routed through the
 * intent classifier (T039) and dispatched to the matching workflow. The old
 * ad-hoc `processRequest` pipeline path is removed for comment triggers —
 * all comment-driven work now lands in `workflow_runs` via the same
 * dispatcher the label trigger uses.
 */
export function handleIssueComment(
  octokit: Octokit,
  payload: IssueCommentEvent,
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
    issueNumber: payload.issue.number,
    senderLogin,
  });

  log.info("Trigger detected in issue_comment — routing via intent classifier");

  const auth = isOwnerAllowed(payload.repository.owner.login, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "issue_comment dropped — owner not allowlisted");
    return;
  }

  // Acknowledge receipt before the (slow) intent classifier kicks off so the
  // user sees an immediate reaction. Subsequent dispatch/handler stages stack
  // rocket / hooray / confused on top.
  void addReaction({
    octokit,
    logger: log,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    commentId: payload.comment.id,
    eventType: "issue_comment",
    content: "eyes",
  });

  const isPR = payload.issue.pull_request !== undefined;

  void dispatchByIntent({
    octokit,
    logger: log,
    commentBody: payload.comment.body,
    target: {
      type: isPR ? "pr" : "issue",
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      number: payload.issue.number,
    },
    senderLogin,
    deliveryId,
    triggerCommentId: payload.comment.id,
    triggerEventType: "issue_comment",
  }).catch((err: unknown) => {
    log.error({ err }, "dispatchByIntent threw for issue_comment");
  });
}
