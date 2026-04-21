import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";

/**
 * `review` handler (T023) — runs a review pass on an open pull request.
 *
 * Stop bounds (ported verbatim from the `pr-auto` skill, per FR-005(c)):
 *   - `FIX_ATTEMPTS_CAP = 3` — max consecutive CI-fix attempts per PR before
 *     handing off to a human. Tracked across runs in `state.fix_attempts`.
 *   - `POLL_WAIT_SECS_CAP = 900` — 15-minute reviewer-patience window after
 *     which the bot stops waiting for a slow reviewer. Advisory here (the
 *     handler itself is not a polling loop — each re-application of
 *     `bot:review` does one iteration; ship-composite orchestration handles
 *     multi-iteration waits).
 *
 * Comment-validity taxonomy (also from `pr-auto` review-comments skill):
 *   - **Valid**          — reviewer is right; fix required.
 *   - **Partially Valid**— reviewer is partially right; fix scoped portion.
 *   - **Invalid**        — reviewer is wrong; reply with evidence, no code change.
 *   - **Needs Clarification** — ambiguous; reply asking a specific question.
 *
 * The classification itself is delegated to the multi-turn agent via the
 * prompt — the handler does not call the LLM directly. This keeps the
 * heuristic in one place (the prompt) and lets the agent use repo context.
 *
 * Non-negotiable: this handler MUST NEVER call `octokit.rest.pulls.merge`
 * (FR-017). Merging stays a human action.
 */

export const FIX_ATTEMPTS_CAP = 3;
export const POLL_WAIT_SECS_CAP = 900;

export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;

  try {
    if (target.type !== "pr") {
      return { status: "failed", reason: "review requires PR target" };
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });

    if (pr.state !== "open") {
      return {
        status: "failed",
        reason: `PR #${String(target.number)} is ${pr.state}; review requires an open PR`,
      };
    }

    const checks = await octokit.rest.checks.listForRef({
      owner: target.owner,
      repo: target.repo,
      ref: pr.head.sha,
    });
    const failingChecks = checks.data.check_runs
      .filter(
        (c) =>
          c.status === "completed" &&
          c.conclusion !== "success" &&
          c.conclusion !== "neutral" &&
          c.conclusion !== "skipped",
      )
      .map((c) => c.name);

    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });
    const unresolvedComments = reviewComments.filter((c) => c.in_reply_to_id === undefined);

    const triggerBody = buildReviewPrompt({
      prNumber: target.number,
      prTitle: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      failingChecks,
      unresolvedCount: unresolvedComments.length,
    });

    const botCtx: BotContext = {
      owner: target.owner,
      repo: target.repo,
      entityNumber: target.number,
      isPR: true,
      eventName: "pull_request_review_comment",
      triggerUsername: "chrisleekr-bot[bot]",
      triggerTimestamp: new Date().toISOString(),
      triggerBody,
      commentId: 0,
      deliveryId: deliveryId ?? runId,
      defaultBranch: pr.base.ref,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      labels: [],
      skipTrackingComments: true,
      octokit,
      log,
    };

    const result = await runPipeline(botCtx);
    if (!result.success) {
      return { status: "failed", reason: "review pipeline execution failed" };
    }

    const state = {
      pr_number: target.number,
      failing_checks: failingChecks,
      unresolved_comments: unresolvedComments.length,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    const humanMessage =
      failingChecks.length === 0 && unresolvedComments.length === 0
        ? `review passed — no failing checks, no unresolved review comments.`
        : `review iteration complete — ${String(failingChecks.length)} failing checks, ${String(unresolvedComments.length)} unresolved comments.`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        failingChecks: failingChecks.length,
        unresolvedComments: unresolvedComments.length,
        costUsd: result.costUsd,
      },
      "review handler succeeded",
    );
    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "review handler caught error");
    return { status: "failed", reason: `review failed: ${message}` };
  }
};

function buildReviewPrompt(input: {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  failingChecks: readonly string[];
  unresolvedCount: number;
}): string {
  return [
    `You are a PR review agent for pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    ``,
    `CI status:`,
    input.failingChecks.length === 0
      ? `  - all checks passing`
      : `  - failing checks: ${input.failingChecks.join(", ")}`,
    `Unresolved reviewer comments: ${String(input.unresolvedCount)}`,
    ``,
    `Do the following in order:`,
    `1. If failing checks exist, fetch their logs (gh run view --log-failed) and classify the failure. If it's a test / lint / type / build failure with a clear root cause, attempt one fix — diagnose, edit, commit, push. Do NOT retry more than once per run (FIX_ATTEMPTS_CAP=3 is tracked across runs).`,
    `2. For every unresolved review comment, classify into one of: Valid | Partially Valid | Invalid | Needs Clarification. For Valid/Partially Valid: fix the code, commit, push, and reply to the comment with the commit SHA and a one-sentence explanation. For Invalid: reply with evidence-backed explanation, no code changes. For Needs Clarification: reply asking the specific question needed to proceed.`,
    `3. If all checks pass AND all comments resolved AND reviewDecision is APPROVED, post a one-line "review complete — ready to merge" comment.`,
    `4. NEVER call \`gh pr merge\` or \`octokit.pulls.merge\`. Merging is a human action (FR-017).`,
    `5. NEVER push to the base branch ${input.baseBranch}.`,
  ].join("\n");
}
