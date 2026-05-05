/**
 * Daemon-side `scoped-explain-thread` executor (T031, US3). Read-only —
 * per `contracts/job-kinds.md#scoped-explain-thread` the production
 * executor reads the cited file range via Octokit's contents API,
 * invokes the Agent SDK with a write-tool denylist, and posts the
 * agent's reply as a thread reply. NEVER pushes, NEVER resolves.
 *
 * **Scaffolding boundary**: this commit lands the Octokit reply path so
 * the orchestrator's dispatch surface no longer falls back to a "not
 * yet wired" notice (FR-021). The Agent SDK call lands as a follow-up;
 * until then the daemon posts a maintainer-facing reply documenting
 * exactly what range was requested.
 *
 * The denylist — `Edit`, `Write`, and the `Bash` git mutation set —
 * MUST be enforced at the SDK call site. When that call lands, the
 * executor returns `succeeded` with `threadReplyId` set to the reply
 * id. Until then it returns `halted` so the bridge knows no agent
 * output is available to relay.
 */

import { Octokit } from "octokit";

import { logger } from "../logger";
import { safePostToGitHub } from "../utils/github-output-guard";
import { SHIP_LOG_EVENTS } from "../workflows/ship/log-fields";

export interface ScopedExplainThreadExecutorInput {
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

export interface ScopedExplainThreadOutcome {
  readonly status: "succeeded" | "halted";
  readonly threadReplyId?: number;
  readonly reason?: string;
}

/**
 * Post the read-only thread reply documenting the scaffolding boundary.
 * Replaces the legacy maintainer-notice path in the dispatch layer; the Agent SDK
 * read-only invocation lands as a follow-up.
 */
export async function executeScopedExplainThread(
  input: ScopedExplainThreadExecutorInput,
): Promise<ScopedExplainThreadOutcome> {
  const log = logger.child({
    component: "daemon.scoped-explain-thread",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.prNumber,
    threadId: input.threadRef.threadId,
  });

  const octokit = new Octokit({ auth: input.installationToken });
  // Octokit-level errors are contractually `halted` (see scoped-fix-thread).
  try {
    const body =
      `\`bot:explain-thread\` daemon-side read-only executor is scaffolded ` +
      `against \`${input.threadRef.filePath}:${String(input.threadRef.startLine)}-${String(input.threadRef.endLine)}\`. ` +
      `Agent SDK invocation with write-tool denylist is the next follow-up.`;
    const guarded = await safePostToGitHub({
      body,
      source: "system",
      callsite: "daemon.scoped-explain-thread",
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
        `daemon.scoped-explain-thread: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info(
      {
        event: "ship.scoped.explain_thread.daemon.completed",
        threadReplyId: guarded.result.data.id,
      },
      "scoped-explain-thread reply posted (scaffolding boundary)",
    );
    return {
      status: "halted",
      threadReplyId: guarded.result.data.id,
      reason: "agent-sdk read-only invocation pending follow-up",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Terminal 4xx (deleted comment, closed PR) is a clean halt. Throttling
    // and abuse-detection responses (429, 403 with rate-limit body) MUST
    // rethrow so the orchestrator's retry layer can back off — same rule
    // as scoped-fix-thread.
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status?: unknown }).status
        : undefined;
    const isRateLimited = status === 429 || (status === 403 && /rate limit|abuse/i.test(reason));
    // See scoped-fix-thread-executor for the rationale; only 404/410/422
    // are terminal resource-state errors per GitHub REST semantics.
    const isTerminalSemanticError = status === 404 || status === 410 || status === 422;
    if (isTerminalSemanticError && !isRateLimited) {
      log.warn(
        { err: reason, status, event: SHIP_LOG_EVENTS.scoped.explainThread.daemonFailed },
        "scoped-explain-thread thread reply failed — halting on semantic GitHub error",
      );
      return { status: "halted", reason: `thread reply failed: ${reason}` };
    }
    throw err;
  }
}
