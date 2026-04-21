import { runPipeline } from "../../core/pipeline";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";
import { findLatestForTarget } from "../runs-store";

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

    const planRow = await findLatestForTarget("plan", {
      owner: target.owner,
      repo: target.repo,
      number: target.number,
    });
    if (planRow?.status !== "succeeded") {
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
      `- Push the branch and open a pull request targeting ${defaultBranch}.`,
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

    const result = await runPipeline(botCtx);
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

    const state = {
      pr_number: opened.number,
      pr_url: opened.url,
      branch: opened.branch,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };
    const humanMessage = `implement complete — opened PR [#${String(opened.number)}](${opened.url}) on branch \`${opened.branch}\`.`;
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
 * Locate the PR the agent opened during this pipeline run. We list recently
 * updated open PRs and pick the most recent one created at or after `since`.
 * Scoped to this repo to keep the query cheap.
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
    per_page: 10,
  });
  for (const pr of prs) {
    const created = new Date(pr.created_at).getTime();
    if (created >= since.getTime() - 5_000) {
      return { number: pr.number, url: pr.html_url, branch: pr.head.ref };
    }
  }
  return null;
}
