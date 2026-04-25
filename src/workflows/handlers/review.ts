import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";

/**
 * `review` handler — proactive senior-developer code review on an open PR.
 *
 * Distinct from `resolve`:
 *   - `resolve` reacts to existing reviewer feedback + failing CI.
 *   - `review` reads the diff against base, walks the full files in the
 *     cloned repo, and posts inline findings via
 *     `octokit.rest.pulls.createReview` (event: `COMMENT`).
 *
 * The agent is instructed to operate as a senior engineer: read changed
 * files in their entirety (not just hunks), cross-reference with the rest
 * of the codebase, run tests when uncertain, and only post findings it
 * can defend with evidence. Each finding is severity-tagged
 * (`[blocker]` / `[major]` / `[minor]` / `[nit]`) so the PR author can
 * triage at a glance.
 *
 * No-findings case: the handler still posts a top-level review body
 * documenting WHAT was checked and WHY no issues were flagged — silence
 * looks indistinguishable from "didn't actually look," and reviewers earn
 * trust by showing their work.
 *
 * Cost note: full-context review (clone + per-file Read + diff) is more
 * expensive than diff-only. This is intentional — accuracy beats cost,
 * per FR-005(c) (review must be senior-grade) and explicit project
 * direction (2026-04-25).
 */

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

    const triggerBody = buildReviewPrompt({
      prNumber: target.number,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
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
      head_sha: pr.head.sha,
      changed_files: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
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

    const headline = `🔍 **Code review complete** — ${String(pr.changed_files)} files, +${String(pr.additions)}/-${String(pr.deletions)}.`;
    const reportSection =
      report.length > 0 ? `\n\n${report}` : `\n\n_(no REVIEW.md report — agent did not write one)_`;
    const humanMessage = `${headline}${reportSection}${metaLine}`;

    await ctx.setState(state, humanMessage);
    log.info(
      {
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
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
  prBody: string;
  headBranch: string;
  baseBranch: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}): string {
  return [
    `You are a senior software engineer performing a code review on pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    `Diff size: ${String(input.changedFiles)} files, +${String(input.additions)}/-${String(input.deletions)} lines.`,
    ``,
    `## PR description`,
    input.prBody.trim().length > 0 ? input.prBody : "_(empty)_",
    ``,
    `## Your task`,
    `Review this PR as a senior engineer would. The cloned repo is your working tree (\`pwd\`). The base branch is \`origin/${input.baseBranch}\`. Both branches are checked out; the working tree is on \`${input.headBranch}\`.`,
    ``,
    `Do the following IN ORDER:`,
    ``,
    `1. **Survey the diff.** \`git diff origin/${input.baseBranch}...HEAD\` to see every change. Note files, scope, and any obvious red flags.`,
    ``,
    `2. **Read changed files in full.** Do NOT review from hunks alone — open every changed file with \`Read\` and understand the surrounding code. The diff shows what changed; the file shows whether the change is correct in context.`,
    ``,
    `3. **Cross-reference.** For each changed function/type/symbol, search the rest of the repo for callers, tests, and related code. \`Grep\` and \`Glob\` are your tools. A change that compiles can still be wrong because it broke a contract a caller relied on.`,
    ``,
    `4. **Validate uncertainty.** When you're not sure if a change is correct, run the relevant tests (\`bun test path/to/test\`), the typechecker (\`bun run typecheck\`), or the linter (\`bun run lint\`). Don't guess — run the code.`,
    ``,
    `5. **Look for these classes of issue specifically:**`,
    `   - **Correctness bugs** — off-by-one, null/undefined paths, wrong return types, broken invariants`,
    `   - **Security issues** — injection, unsanitized inputs, missing auth checks, secrets in logs`,
    `   - **Concurrency** — race conditions, missing locks, double-decrements, unhandled promise rejections`,
    `   - **Error handling** — silent failures, swallowed exceptions, fallbacks that mask bugs`,
    `   - **API contracts** — breaking changes to public surfaces without migration, schema drift`,
    `   - **Test coverage gaps** — new logic without tests, edge cases the new tests miss`,
    `   - **Performance** — N+1 queries, accidentally O(n²), unbounded growth`,
    `   - **Readability/maintainability** — only flag if it would genuinely confuse a future reader`,
    ``,
    `6. **Post findings as a single GitHub Review.** Resolve OWNER/REPO from \`gh repo view --json nameWithOwner -q .nameWithOwner\`, then call \`gh api repos/OWNER/REPO/pulls/${String(input.prNumber)}/reviews -X POST\` with a JSON body containing:`,
    `   - \`event\`: \`"COMMENT"\` (NEVER \`"APPROVE"\` or \`"REQUEST_CHANGES"\` — those are human prerogatives, FR-017)`,
    `   - \`body\`: a top-level summary explaining WHAT you reviewed and WHY (run gh api to discover commit_id from the PR head SHA).`,
    `   - \`comments\`: an array of inline findings, each with \`path\`, \`line\` (or \`start_line\`+\`line\` for multi-line), \`side: "RIGHT"\`, and \`body\`.`,
    ``,
    `   Each finding's body MUST start with a severity tag and MUST include reasoning the author can act on:`,
    `   - \`[blocker]\` — must fix before merge (broken correctness, security)`,
    `   - \`[major]\` — should fix before merge (likely bug, missing test)`,
    `   - \`[minor]\` — nice to fix (readability, small inefficiency)`,
    `   - \`[nit]\` — taste, optional`,
    ``,
    `   Example finding body: \`[major] This loop never decrements \\\`activeCount\\\` on the early-return path at line 142, so the gauge will drift positive over time. Suggest moving the decrement into a \\\`finally\\\` block.\``,
    ``,
    `7. **No-findings case.** If you genuinely find nothing to flag, you MUST still post a Review with \`event: "COMMENT"\` and a body that lists EXACTLY what you checked (files, classes of issue, tests run) and why you concluded no issues. A silent "looks good" is unacceptable — show your work.`,
    ``,
    `8. **NEVER push commits, NEVER call \`gh pr merge\`, NEVER call \`gh pr review --approve\`.** This handler is read-only against the PR. Code changes belong to \`implement\` and \`resolve\`; merging belongs to humans.`,
    ``,
    `9. **Before finishing**, write \`REVIEW.md\` at the repo root summarizing this review:`,
    `   ## Summary — one paragraph: scope of the review and overall verdict.`,
    `   ## What was checked — files read in full, cross-references performed, tests/lint/typecheck runs.`,
    `   ## Findings — by severity. For each: file:line, issue, recommended fix.`,
    `   ## Reasoning — non-trivial conclusions you reached and why (especially the "no issue here" calls in changed files that COULD have looked sketchy).`,
    `   This becomes the tracking-comment body — be specific, cite files and lines.`,
    ``,
    `Remember: you are a senior engineer. Your goal is to find real bugs, not perform thoroughness theatre. False positives erode trust as much as missed bugs.`,
  ].join("\n");
}
