import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";
import { findLatestSucceededForTarget } from "../runs-store";

/**
 * `implement` handler (T022) — reuses `src/core/pipeline.ts` end-to-end.
 *
 * Contract:
 *   - Requires a prior succeeded `plan` run for this issue (enforced by
 *     dispatcher via `requiresPrior: 'plan'`; re-checked here defensively).
 *   - Passes the plan markdown as the prompt trigger body so the agent
 *     executes the plan step-by-step.
 *   - NEVER pushes to the base branch — enforced by the agent prompt and
 *     pipeline guardrails (FR-016).
 *   - On success, locates the PR the agent opened and records its number,
 *     URL, and head branch in `state`.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log, deliveryId, runId } = ctx;

  try {
    if (target.type !== "issue") {
      return { status: "failed", reason: "implement requires issue target" };
    }

    // Consults succeeded rows only — matches the dispatcher's
    // `requiresPrior: 'plan'` gate (which calls `findLatestSucceededForTarget`).
    // A later failed `plan` re-run must not shadow an earlier valid plan.
    const planRow = await findLatestSucceededForTarget("plan", {
      owner: target.owner,
      repo: target.repo,
      number: target.number,
    });
    if (planRow === null) {
      return { status: "failed", reason: "no succeeded plan row found for target" };
    }
    const planMarkdown = typeof planRow.state["plan"] === "string" ? planRow.state["plan"] : "";
    if (planMarkdown.length === 0) {
      return { status: "failed", reason: "plan row has empty state.plan" };
    }

    const { data: issue } = await octokit.rest.issues.get({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
    });

    await postStartingComment(ctx, {
      title: issue.title,
      number: target.number,
      author: issue.user?.login ?? null,
    });

    const { data: repoData } = await octokit.rest.repos.get({
      owner: target.owner,
      repo: target.repo,
    });
    const defaultBranch = repoData.default_branch;

    const since = new Date();

    const triggerBody = [
      `Execute the following plan for issue #${String(target.number)}: ${issue.title}`,
      ``,
      `Requirements:`,
      `- Create a new feature branch. NEVER push to ${defaultBranch}.`,
      `- Implement the tasks in order.`,
      `- Commit with conventional-commit messages.`,
      `- Open a pull request targeting ${defaultBranch} using the bot PR template:`,
      `  1. Read \`.github/PULL_REQUEST_TEMPLATE/bot-implement.md\` from the cloned repo.`,
      `  2. Fill in every section based on your actual work — Summary, Changes,`,
      `     Files changed (path · one-line rationale), Commits (sha · subject),`,
      `     Tests run (command · result), Verification, and \`Closes #${String(target.number)}\`.`,
      `     Skip the Diagram section unless behaviour or flow actually changes.`,
      `  3. Write the filled template to a temp file (e.g. \`/tmp/pr-body.md\`) and pass it via`,
      `     \`gh pr create --body-file /tmp/pr-body.md\`. Do NOT let \`gh\` auto-pick the`,
      `     human PR template — pass \`--body-file\` explicitly so the bot template wins.`,
      `- Before finishing, write \`IMPLEMENT.md\` at the repo root summarizing what you did.`,
      `  Required sections: ## Summary, ## Files changed (path · one-line rationale),`,
      `  ## Commits (sha · subject), ## Tests run (command · result), ## Verification.`,
      `  This becomes the tracking comment body — be specific, cite files.`,
      ``,
      `--- Plan ---`,
      planMarkdown,
      `--- End plan ---`,
    ].join("\n");

    const botCtx: BotContext = {
      owner: target.owner,
      repo: target.repo,
      entityNumber: target.number,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "chrisleekr-bot[bot]",
      triggerTimestamp: since.toISOString(),
      triggerBody,
      commentId: 0,
      deliveryId: deliveryId ?? runId,
      defaultBranch,
      labels: [],
      skipTrackingComments: true,
      octokit,
      log,
    };

    const result = await runPipeline(botCtx, { captureFiles: ["IMPLEMENT.md"] });
    if (!result.success) {
      return { status: "failed", reason: "implement pipeline execution failed" };
    }

    const opened = await findRecentOpenedPr(octokit, target.owner, target.repo, since);
    if (opened === null) {
      return {
        status: "failed",
        reason: "implement completed but no PR was found",
      };
    }

    const report = result.capturedFiles?.["IMPLEMENT.md"]?.trim() ?? "";

    const state = {
      pr_number: opened.number,
      pr_url: opened.url,
      branch: opened.branch,
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
    const reportSection =
      report.length > 0
        ? `\n\n${report}`
        : `\n\n_(no IMPLEMENT.md report — agent did not write one)_`;
    const humanMessage = `🛠️ **Implement complete** — opened PR [#${String(opened.number)}](${opened.url}) on branch \`${opened.branch}\`.${reportSection}${metaLine}`;
    await ctx.setState(state, humanMessage);

    log.info(
      { prNumber: opened.number, branch: opened.branch, costUsd: result.costUsd },
      "implement handler succeeded",
    );
    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "implement handler caught error");
    return { status: "failed", reason: `implement failed: ${message}` };
  }
};

interface OpenedPr {
  number: number;
  url: string;
  branch: string;
}

/**
 * Locate the PR the agent opened during this pipeline run. Filters on:
 *  - `pr.user.type === "Bot"` — the App's installation token always
 *    authors PRs as the App's bot account, so any non-bot PR is human
 *    work we mustn't claim. We deliberately do NOT hard-code a slug
 *    (e.g. `chrisleekr-bot[bot]`) because the dev and prod installations
 *    publish as different slugs (`chrisleekr-bot-dev[bot]` vs
 *    `chrisleekr-bot[bot]`); a hard-coded match makes the handler return
 *    `failed` for a PR that was actually opened correctly.
 *  - `created_at >= since - 5s` — the run's start. The 5s slop absorbs
 *    clock skew between the daemon's `Date.now()` and GitHub's server.
 *
 * `per_page` is bumped to 30 so a burst of unrelated PRs inside the time
 * window doesn't push ours past the page boundary.
 */
async function findRecentOpenedPr(
  octokit: Parameters<WorkflowHandler>[0]["octokit"],
  owner: string,
  repo: string,
  since: Date,
): Promise<OpenedPr | null> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    sort: "created",
    direction: "desc",
    per_page: 30,
  });
  for (const pr of prs) {
    if (pr.user?.type !== "Bot") continue;
    const created = new Date(pr.created_at).getTime();
    if (created >= since.getTime() - 5_000) {
      return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
    }
  }
  return null;
}

/**
 * Up-front tracking comment so the user sees implement has started before the
 * (5–15 minute) agent run finishes and opens a PR. Best-effort: if the write
 * fails, the handler still proceeds and the terminal setState writes the PR
 * link + IMPLEMENT.md report.
 */
async function postStartingComment(
  ctx: Parameters<WorkflowHandler>[0],
  input: { title: string; number: number; author: string | null },
): Promise<void> {
  const author = input.author === null ? "" : ` (opened by @${input.author})`;
  const body = [
    `🛠️ **Implement starting** — executing plan for issue #${String(input.number)}${author}`,
    ``,
    `> ${input.title}`,
    ``,
    `Cloning the repo, creating a feature branch, and asking the agent to implement`,
    `the plan and open a PR. This typically takes 5–15 minutes. The PR link and`,
    `IMPLEMENT.md summary replace this comment when the agent finishes.`,
  ].join("\n");
  try {
    await ctx.setState({ phase: "starting" }, body);
  } catch (err) {
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "implement starting-comment write failed — continuing without up-front comment",
    );
  }
}
