import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";
import { findById } from "../runs-store";
import { type BranchStaleness, formatRefreshDirective, getBranchStaleness } from "./branch-refresh";

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

    const staleness = await getBranchStaleness(octokit, target.owner, target.repo, target.number);

    // Seed the tracking comment up front so the agent has a comment id to
    // post mid-run progress against. The orchestrator's setState creates
    // the comment on first call and reserves its id in the workflow row;
    // we read that id back and hand it to the pipeline.
    await ctx.setState(
      {
        pr_number: target.number,
        head_sha: pr.head.sha,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
      },
      `🔍 **Code review starting** — ${String(pr.changed_files)} files, +${String(pr.additions)}/-${String(pr.deletions)}. Cloning repo and reading changed files…`,
    );
    const seededRow = await findById(runId);
    const trackingCommentId = seededRow?.tracking_comment_id ?? undefined;
    if (trackingCommentId === undefined || trackingCommentId === null) {
      log.warn({ runId }, "review handler: tracking comment id not found after seed setState");
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
      captureFiles: ["REVIEW.md"],
      ...(trackingCommentId !== undefined && trackingCommentId !== null
        ? { trackingCommentId }
        : {}),
    });
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
  staleness: BranchStaleness;
}): string {
  return [
    `You are a senior software engineer performing a code review on pull request #${String(input.prNumber)}: ${input.prTitle}`,
    `Head: ${input.headBranch} → Base: ${input.baseBranch}`,
    `Diff size: ${String(input.changedFiles)} files, +${String(input.additions)}/-${String(input.deletions)} lines.`,
    ``,
    `## PR description`,
    input.prBody.trim().length > 0 ? input.prBody : "_(empty)_",
    ``,
    formatRefreshDirective(input.staleness),
    ``,
    `## Your task`,
    `Review this PR as a senior engineer would. The cloned repo is your working tree (\`pwd\`). The base branch is \`origin/${input.baseBranch}\`. Both branches are checked out; the working tree is on \`${input.headBranch}\`.`,
    ``,
    `## Tools you MUST use`,
    `- \`mcp__github_inline_comment__create_inline_comment\` — post each finding as an inline comment on the specific file/line. One call per finding. Do NOT batch findings into a single tracking-comment blob.`,
    `- \`mcp__github_comment__update_claude_comment\` — keep the tracking comment refreshed with your current step. Call it at every checkpoint marked **[update tracking comment]** below so the user can see live progress.`,
    `- \`Read\`, \`Grep\`, \`Glob\`, \`Bash\` — for inspecting code, running tests, running typecheck.`,
    ``,
    `**Do NOT** call \`gh api .../reviews -X POST\` to post a multi-comment review. The MCP inline-comment tool handles authentication and posting; the shell \`gh\` path is reserved for read-only queries.`,
    ``,
    `Do the following IN ORDER:`,
    ``,
    `0. **[update tracking comment]** Post: "🔍 Reviewing — refreshing branch (if needed) and surveying diff."`,
    ``,
    `1. **Refresh the branch first if needed** (see "Branch state" above). Reviewing stale code is worse than not reviewing — your findings would be against an old base. After rebase + push, the head SHA changes; re-fetch any cached diff metadata before continuing.`,
    ``,
    `2. **Survey the diff.** \`git diff origin/${input.baseBranch}...HEAD\` to see every change. Note files, scope, and any obvious red flags.`,
    ``,
    `3. **[update tracking comment]** Post: "🔍 Reviewing — reading N changed files in full and cross-referencing." (replace N with the file count)`,
    ``,
    `4. **Read changed files in full.** Do NOT review from hunks alone — open every changed file with \`Read\` and understand the surrounding code. The diff shows what changed; the file shows whether the change is correct in context.`,
    ``,
    `5. **Cross-reference.** For each changed function/type/symbol, search the rest of the repo for callers, tests, and related code. \`Grep\` and \`Glob\` are your tools. A change that compiles can still be wrong because it broke a contract a caller relied on.`,
    ``,
    `6. **[update tracking comment]** Post: "🔍 Reviewing — running validation (typecheck/lint/tests as needed)."`,
    ``,
    `7. **Validate uncertainty.** When you're not sure if a change is correct, run the relevant tests (\`bun test path/to/test\`), the typechecker (\`bun run typecheck\`), or the linter (\`bun run lint\`). Don't guess — run the code.`,
    ``,
    `8. **Look for these classes of issue specifically:**`,
    `   - **Correctness bugs** — off-by-one, null/undefined paths, wrong return types, broken invariants`,
    `   - **Security issues** — injection, unsanitized inputs, missing auth checks, secrets in logs`,
    `   - **Concurrency** — race conditions, missing locks, double-decrements, unhandled promise rejections`,
    `   - **Error handling** — silent failures, swallowed exceptions, fallbacks that mask bugs`,
    `   - **API contracts** — breaking changes to public surfaces without migration, schema drift`,
    `   - **Test coverage gaps** — new logic without tests, edge cases the new tests miss`,
    `   - **Performance** — N+1 queries, accidentally O(n²), unbounded growth`,
    `   - **Readability/maintainability** — only flag if it would genuinely confuse a future reader`,
    ``,
    `9. **[update tracking comment]** Post: "🔍 Reviewing — posting K inline findings." (replace K with the finding count, or "no findings" if none)`,
    ``,
    `10. **Post each finding as an inline comment.** For every issue, call \`mcp__github_inline_comment__create_inline_comment\` with:`,
    `    - \`path\`: the file path relative to repo root`,
    `    - \`line\`: the line number on the **right side** of the diff (the new code)`,
    `    - \`body\`: starts with a severity tag, then the issue and recommended fix`,
    ``,
    `    Severity tags (in body, exactly as written):`,
    `    - \`[blocker]\` — must fix before merge (broken correctness, security)`,
    `    - \`[major]\` — should fix before merge (likely bug, missing test)`,
    `    - \`[minor]\` — nice to fix (readability, small inefficiency)`,
    `    - \`[nit]\` — taste, optional`,
    ``,
    `    Example body: \`[major] This loop never decrements \\\`activeCount\\\` on the early-return path at line 142, so the gauge will drift positive over time. Suggest moving the decrement into a \\\`finally\\\` block.\``,
    ``,
    `    One MCP call per finding. If a finding spans multiple lines, post it on the most relevant single line and reference the range in the body.`,
    ``,
    `11. **No-findings case.** If you genuinely find nothing to flag, do NOT post any inline comments. Instead make the REVIEW.md (step 13) explicit about WHAT you checked and WHY you concluded no issues. A silent "looks good" is unacceptable — show your work in REVIEW.md.`,
    ``,
    `12. **Push policy.** The ONLY acceptable push from this handler is \`git push --force-with-lease\` after a clean rebase onto base in step 1 — same diff, fresh head SHA, no new edits. **NEVER create commits with code changes** (no \`git commit\` of edits — code changes belong to \`implement\` and \`resolve\`). **NEVER call \`gh pr merge\`.** **NEVER call \`gh pr review --approve\` / \`--request-changes\`** — those verdicts belong to humans (FR-017).`,
    ``,
    `13. **Write \`REVIEW.md\` at the repo root** summarizing this review:`,
    `    ## Summary — one paragraph: scope of the review and overall verdict.`,
    `    ## What was checked — files read in full, cross-references performed, tests/lint/typecheck runs.`,
    `    ## Findings — by severity. For each: file:line, issue, recommended fix. Mirrors the inline comments you posted (or "no findings — see Reasoning").`,
    `    ## Reasoning — non-trivial conclusions you reached and why (especially the "no issue here" calls in changed files that COULD have looked sketchy).`,
    `    This becomes the final tracking-comment body — be specific, cite files and lines.`,
    ``,
    `14. **[update tracking comment]** Final: paste the full REVIEW.md contents (or a link/summary if it exceeds GitHub's comment size limit).`,
    ``,
    `Remember: you are a senior engineer. Your goal is to find real bugs, not perform thoroughness theatre. False positives erode trust as much as missed bugs.`,
  ].join("\n");
}
