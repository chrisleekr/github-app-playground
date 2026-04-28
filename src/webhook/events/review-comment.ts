import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { config } from "../../config";
import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { addReaction } from "../../utils/reactions";
import { dispatchByIntent } from "../../workflows/dispatcher";
import { dispatchCommentSurface } from "../../workflows/ship/command-dispatch";
import { fireReactor } from "../../workflows/ship/reactor-bridge";
import { isOwnerAllowed } from "../authorize";

/**
 * Handler for pull_request_review_comment.{created,edited,deleted} events.
 *
 * - `created`/`edited`/`deleted` (T025): fire the ship reactor so any active
 *   intent wakes early to re-evaluate open-thread state.
 * - `created` only: trigger detection → owner allowlist → `dispatchByIntent`
 *   (T039). Review comments always target a PR.
 */
export function handleReviewComment(
  octokit: Octokit,
  payload: PullRequestReviewCommentEvent,
  deliveryId: string,
): void {
  if (
    (payload.action === "created" || payload.action === "edited" || payload.action === "deleted") &&
    payload.installation !== undefined
  ) {
    fireReactor({
      type: "pull_request_review_comment",
      installation_id: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pr_number: payload.pull_request.number,
    });
  }

  if (payload.action !== "created") return;
  if (payload.comment.user.type === "Bot") return;

  // T028e: ship trigger-surface dispatch (flag-gated). Review comments
  // always target a PR. The legacy intent-classifier dispatch below is
  // preserved.
  if (config.shipUseTriggerSurfacesV2 && payload.installation !== undefined) {
    const installationId = payload.installation.id;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const principalLogin = payload.comment.user.login;
    const commentBody = payload.comment.body;
    const dispatchLog = logger.child({ deliveryId, owner, repo, prNumber });
    void dispatchCommentSurface({
      commentBody,
      principal_login: principalLogin,
      pr: { owner, repo, number: prNumber, installation_id: installationId },
      octokit,
      log: dispatchLog,
    }).catch((err: unknown) => {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for review_comment");
    });
  }

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

  void addReaction({
    octokit,
    logger: log,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    commentId: payload.comment.id,
    eventType: "pull_request_review_comment",
    content: "eyes",
  });

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
    triggerCommentId: payload.comment.id,
    triggerEventType: "pull_request_review_comment",
  }).catch((err: unknown) => {
    log.error({ err }, "dispatchByIntent threw for review_comment");
  });
}
