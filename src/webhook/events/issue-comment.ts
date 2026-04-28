import type { IssueCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { addReaction } from "../../utils/reactions";
import { dispatchByIntent } from "../../workflows/dispatcher";
import { dispatchCommentSurface } from "../../workflows/ship/command-dispatch";
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

  // Trigger-surface dispatch (T028e + T090). PR comments and Issue
  // comments share the same `issue_comment` event; the
  // `payload.issue.pull_request` flag distinguishes them. Both
  // surfaces flow through `dispatchCommentSurface` with the
  // appropriate `event_surface` tag so per-intent eligibility
  // (FR-029..FR-035) is enforced — e.g., `bot:investigate` only fires
  // on Issue comments and `bot:summarize` only on PR comments.
  if (payload.installation !== undefined) {
    const installationId = payload.installation.id;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const targetNumber = payload.issue.number;
    const principalLogin = payload.comment.user.login;
    const commentBody = payload.comment.body;
    const eventSurface = payload.issue.pull_request === undefined ? "issue-comment" : "pr-comment";
    const dispatchLog = logger.child({
      deliveryId,
      owner,
      repo,
      target_number: targetNumber,
      event_surface: eventSurface,
    });
    void dispatchCommentSurface({
      commentBody,
      principal_login: principalLogin,
      pr: { owner, repo, number: targetNumber, installation_id: installationId },
      event_surface: eventSurface,
      octokit,
      log: dispatchLog,
    }).catch((err: unknown) => {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for issue_comment");
    });
  }

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
