import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";
import { findById } from "../runs-store";
import { type BranchStaleness, formatRefreshDirective, getBranchStaleness } from "./branch-refresh";

/**
 * `resolve` handler — runs a resolution pass on an open pull request:
 * fixes failing CI and replies to/fixes reviewer comments. Renamed from
 * `review` because the previous name implied proactive code review,
 * whereas the actual job is responding to existing reviewer feedback.
 *
 * Stop bounds (ported verbatim from the `pr-auto` skill, per FR-005(c)):
 *   - `FIX_ATTEMPTS_CAP = 3` — max CI-fix attempts the agent should make
 *     within a single resolve iteration. Currently surfaced only via prompt
 *     interpolation (the agent self-enforces it); cross-run enforcement
 *     would require persisting `fix_attempts` to `state` and is intentionally
 *     deferred until we see real overrun in production.
 *   - `POLL_WAIT_SECS_CAP = 900` — 15-minute reviewer-patience window after
 *     which the bot stops waiting for a slow reviewer. Advisory here (the
 *     handler itself is not a polling loop — each re-application of
 *     `bot:resolve` does one iteration; ship-composite orchestration handles
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
      return { status: "failed", reason: "resolve requires PR target" };
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });

    if (pr.state !== "open") {
      return {
        status: "failed",
        reason: `PR #${String(target.number)} is ${pr.state}; resolve requires an open PR`,
      };
    }

    // Paginate — `checks.listForRef` defaults to per_page=30. On busy PRs
    // with large CI matrices, a non-paginated call silently under-reports
    // failing checks and the resolve prompt gets a stale picture.
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
    // surfaces it as "open comment threads (some may already be resolved)";
    // resolved threads are over-counted but never under-counted.
    //
    // Paginate — `listReviewComments` defaults to per_page=30 like
    // `listForRef`. Without paginate, large PRs silently undercount.
    const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      per_page: 100,
    });
    const topLevelComments = reviewComments.filter((c) => c.in_reply_to_id === undefined);

    const staleness = await getBranchStaleness(octokit, target.owner, target.repo, target.number);

    // Seed the tracking comment up front so the agent can post mid-run
    // progress against it. See review.ts for the same pattern + rationale.
    await ctx.setState(
      {
        pr_number: target.number,
        failing_checks: failingChecks,
        top_level_comments: topLevelComments.length,
      },
      `🔎 **Resolve starting** — ${String(failingChecks.length)} failing checks, ${String(topLevelComments.length)} open comment threads. Refreshing branch and classifying feedback…`,
    );
    const seededRow = await findById(runId);
    const trackingCommentId = seededRow?.tracking_comment_id ?? undefined;
    if (trackingCommentId === undefined || trackingCommentId === null) {
      log.warn({ runId }, "resolve handler: tracking comment id not found after seed setState");
    }

    const triggerBody = buildResolvePrompt({
      prNumber: target.number,
      prTitle: pr.title,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      failingChecks,
      topLevelCommentCount: topLevelComments.length,
      staleness,
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
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, {
      captureFiles: ["RESOLVE.md"],
      ...(trackingCommentId !== undefined && trackingCommentId !== null
        ? { trackingCommentId }
        : {}),
      ...(topLevelComments.length > 0 ? { enableResolveReviewThread: true } : {}),
    });
    if (!result.success) {
      return { status: "failed", reason: "resolve pipeline execution failed" };
    }

    const report = result.capturedFiles?.["RESOLVE.md"]?.trim() ?? "";

    const state = {
      pr_number: target.number,
      failing_checks: failingChecks,
      top_level_comments: topLevelComments.length,
      branch_state: {
        commits_behind_base: staleness.commitsBehindBase,
        commits_ahead_of_base: staleness.commitsAheadOfBase,
        is_fork: staleness.isFork,
      },
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
        ? `🔎 **Resolve passed** — no failing checks, no open review comments.`
        : `🔎 **Resolve iteration complete** — ${String(failingChecks.length)} failing checks, ${String(topLevelComments.length)} open comment threads (some may already be resolved).`;
    const reportSection =
      report.length > 0
        ? `\n\n${report}`
        : `\n\n_(no RESOLVE.md report — agent did not write one)_`;
    const humanMessage = `${headline}${reportSection}${metaLine}`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        failingChecks: failingChecks.length,
        topLevelComments: topLevelComments.length,
        costUsd: result.costUsd,
      },
      "resolve handler succeeded",
    );
    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "resolve handler caught error");
    return { status: "failed", reason: `resolve failed: ${message}` };
  }
};

function buildResolvePrompt(input: {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  baseBranch: string;
  failingChecks: readonly string[];
  topLevelCommentCount: number;
  staleness: BranchStaleness;
}): string {
  return [
    `You are a PR resolve agent for pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    ``,
    `CI status:`,
    input.failingChecks.length === 0
      ? `  - all checks passing`
      : `  - failing checks: ${input.failingChecks.join(", ")}`,
    `Open comment threads (some may already be resolved): ${String(input.topLevelCommentCount)}`,
    ``,
    formatRefreshDirective(input.staleness),
    ``,
    `## Tools you MUST use`,
    `- \`mcp__github_comment__update_claude_comment\` — refresh the tracking comment at every checkpoint marked **[update tracking comment]** so the user sees live progress.`,
    `- \`Bash\` (\`gh\`, \`git\`) — \`gh\` and \`git\` are pre-authenticated as the GitHub App installation in this environment, so \`gh pr view\`, \`gh run view --log-failed\`, \`gh api .../pulls/comments/<id>/replies\`, \`git commit\`, \`git push\` all work without further setup.`,
    `- \`Read\`, \`Edit\`, \`Grep\`, \`Glob\` — for code edits and exploration.`,
    ``,
    `Do the following in order:`,
    `0. **[update tracking comment]** Post: "🔎 Resolve — refreshing branch (if needed)."`,
    `1. **Refresh the branch first if needed** (see "Branch state" above). A senior engineer rebases before triaging anything; resolving feedback against a stale branch is wasted work.`,
    `2. **[update tracking comment]** Post: "🔎 Resolve — diagnosing N failing checks." (replace N; skip this step if N=0)`,
    `3. If failing checks exist, fetch their logs (\`gh run view --log-failed\`) and classify the failure. If it's a test / lint / type / build failure with a clear root cause, attempt one fix — diagnose, edit, commit, push. Do NOT retry more than once per run (FIX_ATTEMPTS_CAP=3 is the per-iteration cap; cross-run enforcement is not yet wired).`,
    `4. **[update tracking comment]** Post: "🔎 Resolve — classifying K open comment threads." (replace K; skip if K=0)`,
    `5. For each open comment thread, classify into one of: Valid | Partially Valid | Invalid | Needs Clarification. The count above is an upper bound — some threads may already be resolved, in which case skip them. For Valid/Partially Valid: fix the code, commit, push, and reply to the comment via \`gh api repos/OWNER/REPO/pulls/${String(input.prNumber)}/comments/<comment_id>/replies -X POST -f body="..."\` with the commit SHA and a one-sentence explanation. For Invalid: reply with evidence-backed explanation, no code changes. For Needs Clarification: reply asking the specific question needed to proceed.`,
    `6. If all checks pass AND all comments resolved AND reviewDecision is APPROVED, post a one-line "review complete — ready to merge" comment via \`update_claude_comment\`.`,
    `7. NEVER call \`gh pr merge\` or \`octokit.pulls.merge\`. Merging is a human action (FR-017).`,
    `8. NEVER push to the base branch ${input.baseBranch}.`,
    `9. **Before finishing**, write \`RESOLVE.md\` at the repo root summarizing this resolve iteration.`,
    `   Required sections:`,
    `   ## Summary — one paragraph: what state the PR is in now and what's left.`,
    `   ## CI status — list each failing check and what you did about it.`,
    `   ## Review comments — for each comment: classification, action taken, commit/reply link.`,
    `   ## Commits pushed — sha · subject.`,
    `   ## Outstanding — what still blocks merge (if anything).`,
    `   This becomes the final tracking comment body — be specific, cite files and links.`,
    `10. **[update tracking comment]** Final: paste the full RESOLVE.md contents.`,
  ].join("\n");
}
