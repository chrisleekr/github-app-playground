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

  // Authorize before dispatch — both the canonical (`dispatchCommentSurface`)
  // and legacy (`dispatchByIntent`) paths share the same allowlist gate so
  // a dropped repo can't slip through canonical routing. Mirrors the
  // structure used in `issues.ts`, `pull-request.ts`, and `review-comment.ts`.
  const senderLogin = payload.comment.user.login;
  const ownerLogin = payload.repository.owner.login;
  const log = logger.child({
    deliveryId,
    owner: ownerLogin,
    repo: payload.repository.name,
    issueNumber: payload.issue.number,
    senderLogin,
  });

  const auth = isOwnerAllowed(ownerLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "issue_comment dropped — owner not allowlisted");
    return;
  }

  if (payload.installation === undefined) return;

  const installationId = payload.installation.id;
  const owner = ownerLogin;
  const repo = payload.repository.name;
  const targetNumber = payload.issue.number;
  const commentBody = payload.comment.body;
  const isPR = payload.issue.pull_request !== undefined;
  const eventSurface = isPR ? "pr-comment" : "issue-comment";

  // Trigger-surface dispatch (T028e + T090). PR comments and Issue
  // comments share the same `issue_comment` event; the
  // `payload.issue.pull_request` flag distinguishes them. The
  // `event_surface` tag enforces per-intent eligibility — e.g.,
  // `bot:investigate` only fires on Issue comments and `bot:summarize`
  // only on PR comments. Canonical wins; legacy `dispatchByIntent`
  // runs only when canonical produced no command.
  void (async (): Promise<void> => {
    const dispatchLog = log.child({ event_surface: eventSurface });
    let canonicalHandled = false;
    try {
      canonicalHandled = await dispatchCommentSurface({
        commentBody,
        principal_login: senderLogin,
        pr: { owner, repo, number: targetNumber, installation_id: installationId },
        event_surface: eventSurface,
        octokit,
        log: dispatchLog,
      });
    } catch (err) {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for issue_comment");
    }

    if (canonicalHandled) return;
    if (!containsTrigger(commentBody)) return;

    log.info("Trigger detected in issue_comment — routing via intent classifier");

    void addReaction({
      octokit,
      logger: log,
      owner,
      repo,
      commentId: payload.comment.id,
      eventType: "issue_comment",
      content: "eyes",
    });

    try {
      await dispatchByIntent({
        octokit,
        logger: log,
        commentBody,
        target: { type: isPR ? "pr" : "issue", owner, repo, number: targetNumber },
        senderLogin,
        deliveryId,
        triggerCommentId: payload.comment.id,
        triggerEventType: "issue_comment",
      });
    } catch (err) {
      log.error({ err }, "dispatchByIntent threw for issue_comment");
    }
  })();
}
