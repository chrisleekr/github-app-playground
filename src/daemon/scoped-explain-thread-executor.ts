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
    const reply = await octokit.rest.pulls.createReplyForReviewComment({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      comment_id: input.threadRef.commentId,
      body:
        `\`bot:explain-thread\` daemon-side read-only executor is scaffolded ` +
        `against \`${input.threadRef.filePath}:${String(input.threadRef.startLine)}-${String(input.threadRef.endLine)}\`. ` +
        `Agent SDK invocation with write-tool denylist is the next follow-up.`,
    });
    log.info(
      { event: "ship.scoped.explain_thread.daemon.completed", threadReplyId: reply.data.id },
      "scoped-explain-thread reply posted (scaffolding boundary)",
    );
    return {
      status: "halted",
      threadReplyId: reply.data.id,
      reason: "agent-sdk read-only invocation pending follow-up",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Only 4xx (deleted comment, closed PR) is a clean halt. Transport
    // failures and 5xx must rethrow so the outer catch reports `failed`.
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? (err as { status?: unknown }).status
        : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) {
      log.warn(
        { err: reason, status, event: SHIP_LOG_EVENTS.scoped.explainThread.daemonFailed },
        "scoped-explain-thread thread reply failed — halting on semantic GitHub error",
      );
      return { status: "halted", reason: `thread reply failed: ${reason}` };
    }
    throw err;
  }
}
