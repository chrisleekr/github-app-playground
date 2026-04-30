import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

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

  // Authorize before dispatch — both the canonical (`dispatchCommentSurface`)
  // and legacy (`dispatchByIntent`) paths share the same allowlist gate so
  // a dropped repo can't slip through canonical routing. Mirrors the
  // structure used in `issues.ts` and `pull-request.ts` label handlers.
  const senderLogin = payload.comment.user.login;
  const ownerLogin = payload.repository.owner.login;
  const log = logger.child({
    deliveryId,
    owner: ownerLogin,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
    senderLogin,
  });

  const auth = isOwnerAllowed(ownerLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "review_comment dropped — owner not allowlisted");
    return;
  }

  // T028e + T089: ship trigger-surface dispatch. Review comments always
  // target a PR; carry the `event_surface: 'review-comment'` tag and
  // the originating comment's REST `id` as `thread_id` so scoped commands
  // that act on a specific thread (`bot:fix-thread`, `bot:explain-thread`)
  // can resolve the target.
  //
  // **Identifier semantics** (CanonicalCommand.thread_id): the value below
  // is the REST `payload.comment.id`, NOT the GraphQL
  // `PullRequestReviewThread` node ID. Handlers that call the GraphQL
  // `resolveReviewThread` mutation (e.g., the MCP `resolve-review-thread`
  // server) MUST resolve the parent thread node ID at execution time
  // via GraphQL (`pullRequestReviewThread` keyed on the comment).
  // Pre-fetching the node ID here would impose an extra GraphQL round
  // trip on every review-comment webhook — including comments that
  // never trigger a scoped command.
  //
  // Canonical routing is awaited; the legacy `dispatchByIntent` path
  // below runs only when canonical routing produced no command (the
  // body is not a recognised verb). Without this precedence, an
  // overlapping verb (e.g. `bot:summarize`) fires both pipelines for
  // one webhook.
  if (payload.installation === undefined) return;

  const installationId = payload.installation.id;
  const owner = ownerLogin;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const commentBody = payload.comment.body;
  const threadId = String(payload.comment.id);

  void (async (): Promise<void> => {
    const dispatchLog = log.child({ thread_id: threadId, event_surface: "review-comment" });
    let canonicalHandled = false;
    try {
      canonicalHandled = await dispatchCommentSurface({
        commentBody,
        principal_login: senderLogin,
        pr: { owner, repo, number: prNumber, installation_id: installationId },
        event_surface: "review-comment",
        thread_id: threadId,
        octokit,
        log: dispatchLog,
      });
    } catch (err) {
      dispatchLog.error({ err }, "ship dispatchCommentSurface threw for review_comment");
    }

    if (canonicalHandled) return;
    if (!containsTrigger(commentBody)) return;

    log.info("Trigger detected in review_comment — routing via intent classifier");

    void addReaction({
      octokit,
      logger: log,
      owner,
      repo,
      commentId: payload.comment.id,
      eventType: "pull_request_review_comment",
      content: "eyes",
    });

    try {
      await dispatchByIntent({
        octokit,
        logger: log,
        commentBody,
        target: { type: "pr", owner, repo, number: prNumber },
        senderLogin,
        deliveryId,
        triggerCommentId: payload.comment.id,
        triggerEventType: "pull_request_review_comment",
      });
    } catch (err) {
      log.error({ err }, "dispatchByIntent threw for review_comment");
    }
  })();
}
