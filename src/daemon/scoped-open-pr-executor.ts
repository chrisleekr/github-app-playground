/**
 * Daemon-side `scoped-open-pr` executor (T032, US3). Per
 * `contracts/job-kinds.md#scoped-open-pr` the production executor clones
 * the default branch, scaffolds a feature branch via the Agent SDK,
 * pushes, and opens a PR linking the originating issue.
 *
 * **Scaffolding boundary**: this commit lands the Octokit issue-reply
 * path so the dispatch layer's `createBranchAndPr` callback no longer
 * throws the legacy maintainer-notice (FR-021). The clone + Agent SDK invocation +
 * `createPullRequest` call lands as a follow-up.
 *
 * Halt conditions per the contract:
 *   - Agent produces no diff → halt with `reason: "no scaffold produced"`;
 *     do NOT push an empty branch.
 *   - Default branch is unknown / not protected → halt and surface error.
 *
 * Both become real once the Agent SDK call is wired; the executor today
 * returns `halted` with a structured reason that the server-side
 * completion bridge formats as the user-facing reply.
 */

import { Octokit } from "octokit";

import { logger } from "../logger";
import { safePostToGitHub } from "../utils/github-output-guard";
import { SHIP_LOG_EVENTS } from "../workflows/ship/log-fields";

export interface ScopedOpenPrExecutorInput {
  readonly installationToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly triggerCommentId: number;
  readonly verdictSummary: string;
}

export interface ScopedOpenPrOutcome {
  readonly status: "succeeded" | "failed" | "halted";
  readonly newPrNumber?: number;
  readonly pushedCommitSha?: string;
  readonly reason?: string;
}

/**
 * Post a maintainer-facing reply on the originating issue documenting
 * the scaffolding boundary, then return halted. The verdictSummary is
 * surfaced verbatim so the maintainer can see what the policy layer
 * deemed actionable.
 */
export async function executeScopedOpenPr(
  input: ScopedOpenPrExecutorInput,
): Promise<ScopedOpenPrOutcome> {
  const log = logger.child({
    component: "daemon.scoped-open-pr",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
  });

  const octokit = new Octokit({ auth: input.installationToken });
  // GitHub issue comment max body is 65 536 chars; truncate generously to
  // leave room for the surrounding markdown so a pathological policy summary
  // cannot turn into a 422 (which would otherwise misclassify as `failed`).
  const MAX_SUMMARY_BYTES = 60_000;
  const truncatedSummary =
    input.verdictSummary.length <= MAX_SUMMARY_BYTES
      ? input.verdictSummary
      : `${input.verdictSummary.slice(0, MAX_SUMMARY_BYTES)}\n\n…(truncated)`;
  // Octokit-level errors (closed issue, missing repo) are contractually
  // `halted`, not `failed` — see scoped-fix-thread for rationale.
  try {
    // verdictSummary contains LLM-generated policy text — route through the
    // agent-source path so the LLM scanner runs on the body.
    const guarded = await safePostToGitHub({
      body:
        `\`bot:open-pr\` daemon-side executor is scaffolded — clone + branch + ` +
        `Agent SDK scaffolding + \`gh pr create\` invocation is the next follow-up. ` +
        `Policy verdict (verbatim):\n\n> ${truncatedSummary.replaceAll("\n", "\n> ")}`,
      source: "agent",
      callsite: "daemon.scoped-open-pr-executor.scaffold-reply",
      log,
      post: (cleanBody) =>
        octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issueNumber,
          body: cleanBody,
        }),
    });
    if (!guarded.posted) {
      // Body emptied by secret redaction — do NOT log a misleading "completed"
      // line. Surface a distinct halt so the orchestrator records it
      // separately from a successful scaffold reply.
      log.warn(
        {
          event: "ship.scoped.open_pr.daemon.skipped_after_redaction",
          matchCount: guarded.matchCount,
          kinds: guarded.kinds,
          reason: guarded.reason,
        },
        "scoped-open-pr reply skipped — body emptied by secret redaction",
      );
      return {
        status: "halted",
        reason: `scaffold reply skipped: secret redaction emptied the body (matchCount=${guarded.matchCount})`,
      };
    }
    log.info(
      { event: "ship.scoped.open_pr.daemon.completed" },
      "scoped-open-pr reply posted (scaffolding boundary)",
    );
    return {
      status: "halted",
      reason: "agent-sdk invocation + branch creation pending follow-up",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Terminal 4xx (closed issue, missing repo) is a clean halt. Throttling
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
        { err: reason, status, event: SHIP_LOG_EVENTS.scoped.openPr.daemonFailed },
        "scoped-open-pr issue reply failed — halting on semantic GitHub error",
      );
      return { status: "halted", reason: `issue reply failed: ${reason}` };
    }
    throw err;
  }
}
