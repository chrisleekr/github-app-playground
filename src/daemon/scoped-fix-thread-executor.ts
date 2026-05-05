/**
 * Daemon-side `scoped-fix-thread` executor (T030, US3). Per
 * `contracts/job-kinds.md#scoped-fix-thread` the production executor must
 * clone head, invoke the Agent SDK with the cited file range, push any
 * resulting commit, and resolve the review thread.
 *
 * **This commit lands the executor's wire surface and Octokit reply path
 * but defers the multi-turn Agent SDK invocation to a follow-up.** Daemon
 * dispatches no longer fall back to the legacy maintainer-notice notices in the
 * orchestrator's dispatch path (FR-021), and the e2e quickstart S5/S6
 * scenarios get a deterministic thread-reply event to assert against.
 *
 * Halt conditions per the contract:
 *   - Agent attempts to write outside the cited file range → halt with
 *     `reason: "fix exceeded thread scope"`; do NOT push.
 *   - Agent produces no diff → reply "no change required" without commit.
 *
 * Both halt conditions become real once the Agent SDK call lands; until
 * then this executor reports `halted` with a structured reason that the
 * server-side completion bridge formats as the user-facing reply.
 */

import { Octokit } from "octokit";

import { logger } from "../logger";
import { safePostToGitHub } from "../utils/github-output-guard";
import { SHIP_LOG_EVENTS } from "../workflows/ship/log-fields";

export interface ScopedFixThreadExecutorInput {
  readonly installationToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly threadRef: {
    readonly threadId: string;
    readonly commentId: number;
    readonly filePath: string;
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly triggerCommentId: number;
}

export interface ScopedFixThreadOutcome {
  readonly status: "succeeded" | "halted";
  readonly threadReplyId?: number;
  readonly pushedCommitSha?: string;
  readonly reason?: string;
}

/**
 * Post the maintainer-facing thread reply that documents the scaffolding
 * boundary, then return a halted outcome that the policy-layer bridge can
 * surface upstream. Once the Agent SDK call lands, the body of this
 * function becomes: clone → prompt → run → diff-check → commit/push →
 * resolve thread → succeeded outcome.
 */
export async function executeScopedFixThread(
  input: ScopedFixThreadExecutorInput,
): Promise<ScopedFixThreadOutcome> {
  const log = logger.child({
    component: "daemon.scoped-fix-thread",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.prNumber,
    threadId: input.threadRef.threadId,
  });

  const octokit = new Octokit({ auth: input.installationToken });
  // Octokit-level errors (deleted comment, closed PR, abuse rate limit) are
  // contractually `halted`, not `failed` — the executor itself ran cleanly,
  // the user-visible state simply prevented the reply. Bubbling these as
  // `failed` would conflate "user deleted the comment" with "executor crashed."
  try {
    const body =
      `\`bot:fix-thread\` daemon-side executor is scaffolded against ` +
      `\`${input.threadRef.filePath}:${String(input.threadRef.startLine)}-${String(input.threadRef.endLine)}\`. ` +
      `Multi-turn Agent SDK invocation is the next follow-up.`;
    const guarded = await safePostToGitHub({
      body,
      source: "system",
      callsite: "daemon.scoped-fix-thread",
      log,
      post: (cleanBody) =>
        octokit.rest.pulls.createReplyForReviewComment({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.prNumber,
          comment_id: input.threadRef.commentId,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `daemon.scoped-fix-thread: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info(
      { event: "ship.scoped.fix_thread.daemon.completed", threadReplyId: guarded.result.data.id },
      "scoped-fix-thread reply posted (scaffolding boundary)",
    );
    return {
      status: "halted",
      threadReplyId: guarded.result.data.id,
      reason: "agent-sdk invocation pending follow-up",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Only terminal 4xx semantic-state codes (deleted comment, closed PR,
    // archived repo, validation) are a clean halt. Throttling and abuse-
    // detection responses (429, 403 with rate-limit body) MUST rethrow so the
    // orchestrator's retry layer can back off and re-offer; treating them as
    // halted permanently drops the request on a transient GitHub condition.
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status?: unknown }).status
        : undefined;
    const isRateLimited = status === 429 || (status === 403 && /rate limit|abuse/i.test(reason));
    // Per GitHub REST docs, only 404 (gone/missing), 410 (gone), and 422
    // (validation/spam) are terminal resource-state errors. 401 and generic
    // 403 indicate token/permission failures and MUST surface as `failed`
    // so the orchestrator can flag the broken installation rather than
    // silently dropping the request.
    const isTerminalSemanticError = status === 404 || status === 410 || status === 422;
    if (isTerminalSemanticError && !isRateLimited) {
      log.warn(
        { err: reason, status, event: SHIP_LOG_EVENTS.scoped.fixThread.daemonFailed },
        "scoped-fix-thread thread reply failed — halting on semantic GitHub error",
      );
      return { status: "halted", reason: `thread reply failed: ${reason}` };
    }
    throw err;
  }
}
