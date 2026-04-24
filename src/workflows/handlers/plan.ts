import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { checkoutRepo } from "../../core/checkout";
import { executeAgent } from "../../core/executor";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";

/**
 * `plan` handler (T021) — multi-turn Claude Agent SDK session over the cloned
 * repo + issue body. Emits markdown task decomposition into `state.plan`.
 *
 * Flow:
 *   1. Fetch the issue (title + body) from GitHub.
 *   2. Obtain an installation token and checkout the repo to a temp dir.
 *   3. Run the agent with File system + Bash tools, instructing it to produce
 *      `PLAN.md` at the repo root.
 *   4. Read PLAN.md back and return it as `state.plan`.
 *   5. Cleanup workspace.
 *
 * Uses `executeAgent` directly (not `runPipeline`) so the handler owns the
 * prompt — `runPipeline` builds a prompt from `triggerBody` + fetched GH
 * data, which is tuned for `@chrisleekr-bot` comment triggers, not planning.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log } = ctx;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const { data: issue } = await octokit.rest.issues.get({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
    });

    const defaultBranch = await resolveDefaultBranch(octokit, target.owner, target.repo);

    const { token: installationToken } = (await octokit.auth({
      type: "installation",
    })) as { token: string };

    const botCtx = buildSyntheticBotContext(ctx, defaultBranch);
    const checkout = await checkoutRepo(botCtx, installationToken);
    cleanup = checkout.cleanup;

    const prompt = buildPlanPrompt({
      issueTitle: issue.title,
      issueBody: issue.body ?? "",
      owner: target.owner,
      repo: target.repo,
      number: target.number,
    });

    const result = await executeAgent({
      ctx: botCtx,
      prompt,
      mcpServers: {},
      workDir: checkout.workDir,
      allowedTools: ["Read", "Grep", "Glob", "Write", "Bash"],
      maxTurns: 30,
    });

    if (!result.success) {
      return {
        status: "failed",
        reason: "plan agent execution failed",
      };
    }

    const planPath = join(checkout.workDir, "PLAN.md");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const planMarkdown = await readFile(planPath, "utf8").catch(() => "");
    if (planMarkdown.trim().length === 0) {
      return { status: "failed", reason: "plan agent did not produce PLAN.md" };
    }

    const state = {
      plan: planMarkdown,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };
    const humanMessage = `plan ready — ${String(planMarkdown.split("\n").length)} lines of task decomposition written.`;
    await ctx.setState(state, humanMessage);

    log.info(
      { planLength: planMarkdown.length, costUsd: result.costUsd },
      "plan handler succeeded",
    );
    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "plan handler caught error");
    return { status: "failed", reason: `plan failed: ${message}` };
  } finally {
    if (cleanup !== undefined) {
      await cleanup().catch((err: unknown) => {
        log.warn({ err }, "plan handler cleanup failed");
      });
    }
  }
};

async function resolveDefaultBranch(
  octokit: {
    rest: {
      repos: {
        get: (p: { owner: string; repo: string }) => Promise<{ data: { default_branch: string } }>;
      };
    };
  },
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

function buildSyntheticBotContext(
  ctx: Parameters<WorkflowHandler>[0],
  defaultBranch: string,
): BotContext {
  return {
    owner: ctx.target.owner,
    repo: ctx.target.repo,
    entityNumber: ctx.target.number,
    isPR: ctx.target.type === "pr",
    eventName: "issue_comment",
    triggerUsername: "chrisleekr-bot[bot]",
    triggerTimestamp: new Date().toISOString(),
    triggerBody: `workflow:${ctx.workflowName} run:${ctx.runId}`,
    commentId: 0,
    deliveryId: ctx.deliveryId ?? ctx.runId,
    defaultBranch,
    labels: [],
    skipTrackingComments: true,
    octokit: ctx.octokit,
    log: ctx.logger,
  };
}

function buildPlanPrompt(input: {
  issueTitle: string;
  issueBody: string;
  owner: string;
  repo: string;
  number: number;
}): string {
  return [
    `You are a planning agent. Your job is to read the repository and the issue below, then produce a markdown task decomposition at PLAN.md in the repo root.`,
    ``,
    `Repository: ${input.owner}/${input.repo}`,
    `Issue #${String(input.number)}: ${input.issueTitle}`,
    ``,
    `--- Issue body ---`,
    input.issueBody,
    `--- End issue body ---`,
    ``,
    `Steps:`,
    `1. Read relevant source files (src/, docs/, tests/) to understand context.`,
    `2. Identify the minimal, sequential tasks required to resolve the issue.`,
    `3. Write PLAN.md at the repo root with this structure:`,
    ``,
    `    # Plan: <issue title>`,
    `    ## Context`,
    `    <1-3 sentences on the current state>`,
    `    ## Tasks`,
    `    - [ ] T1 <first task> (files: <paths>)`,
    `    - [ ] T2 <second task> (files: <paths>)`,
    `    ...`,
    `    ## Verification`,
    `    <how to confirm the change works>`,
    ``,
    `4. Keep each task small, specific, and independently verifiable.`,
    `5. Do NOT make code changes yet — only write PLAN.md.`,
    `6. When PLAN.md is written and saved, your job is done.`,
  ].join("\n");
}
