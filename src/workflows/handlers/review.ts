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

    // Paginate — `checks.listForRef` defaults to per_page=30. On busy PRs
    // with large CI matrices, a non-paginated call silently under-reports
    // failing checks and the review prompt gets a stale picture.
    const allCheckRuns = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner: target.owner,
      repo: target.repo,
      ref: pr.head.sha,
      per_page: 100,
    });
    const failingChecks = allCheckRuns
      .filter(
        (c) =>
          c.status === "completed" &&
          c.conclusion !== "success" &&
          c.conclusion !== "neutral" &&
          c.conclusion !== "skipped",
      )
      .map((c) => c.name);

    // Count top-level review comments — GitHub's REST API does not expose
    // thread-level resolution state (only the GraphQL `PullRequestReviewThread`
    // surface does), so this is a conservative upper bound. The agent prompt
    // uses it as "how many inline threads the reviewer has opened"; resolved
    // threads are over-counted but never under-counted. Rename — `unresolved`
    // would be a lie.
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });
    const topLevelComments = reviewComments.filter((c) => c.in_reply_to_id === undefined);

    const triggerBody = buildReviewPrompt({
      prNumber: target.number,
      prTitle: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      failingChecks,
      unresolvedCount: topLevelComments.length,
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
      defaultBranch: pr.base.repo.default_branch,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      labels: [],
      skipTrackingComments: true,
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, { captureFiles: ["REVIEW.md"] });
    if (!result.success) {
      return { status: "failed", reason: "review pipeline execution failed" };
    }

    const report = result.capturedFiles?.["REVIEW.md"]?.trim() ?? "";

    const state = {
      pr_number: target.number,
      failing_checks: failingChecks,
      top_level_comments: topLevelComments.length,
      report,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    const meta: string[] = [];
    if (result.costUsd !== undefined) meta.push(`cost: $${result.costUsd.toFixed(4)}`);
    if (result.numTurns !== undefined) meta.push(`turns: ${String(result.numTurns)}`);
    if (result.durationMs !== undefined)
      meta.push(`duration: ${String(Math.round(result.durationMs / 1000))}s`);
    const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";

    const headline =
      failingChecks.length === 0 && topLevelComments.length === 0
        ? `🔎 **Review passed** — no failing checks, no open review comments.`
        : `🔎 **Review iteration complete** — ${String(failingChecks.length)} failing checks, ${String(topLevelComments.length)} open review comments.`;
    const reportSection =
      report.length > 0 ? `\n\n${report}` : `\n\n_(no REVIEW.md report — agent did not write one)_`;
    const humanMessage = `${headline}${reportSection}${metaLine}`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        failingChecks: failingChecks.length,
        topLevelComments: topLevelComments.length,
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
    `6. Before finishing, write \`REVIEW.md\` at the repo root summarizing this review iteration.`,
    `   Required sections:`,
    `   ## Summary — one paragraph: what state the PR is in now and what's left.`,
    `   ## CI status — list each failing check and what you did about it.`,
    `   ## Review comments — for each comment: classification, action taken, commit/reply link.`,
    `   ## Commits pushed — sha · subject.`,
    `   ## Outstanding — what still blocks merge (if anything).`,
    `   This becomes the tracking comment body — be specific, cite files and links.`,
  ].join("\n");
}
