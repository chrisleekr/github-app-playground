import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { checkoutRepo } from "../../core/checkout";
import { executeAgent } from "../../core/executor";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";

/**
 * `triage` handler — code-aware validation of an issue against the actual
 * repository state.
 *
 * Replaces the prior keyword-regex classifier (which never read the code).
 * The handler:
 *   1. Fetches the issue title + body via Octokit.
 *   2. Clones the repository to a temp working directory.
 *   3. Runs Claude Agent SDK with read-mostly tools (Read/Grep/Glob/Bash)
 *      and instructs the agent to: search relevant source, reproduce-by-reading
 *      the reported behaviour, decide validity, and emit two artefacts at the
 *      repo root — `TRIAGE.md` (human-readable report, becomes the tracking
 *      comment body) and `TRIAGE_VERDICT.json` (machine-readable verdict).
 *   4. Parses `TRIAGE_VERDICT.json`. When `valid === false` the handler
 *      returns `failed` with the verdict summary as the reason — this
 *      halts a parent `ship` cascade at the triage step (see
 *      `workflows/orchestrator.ts onStepComplete`).
 *   5. The full `TRIAGE.md` report is the tracking comment body so the user
 *      sees evidence and reasoning, not a one-liner.
 *
 * The handler does NOT post chat-style summaries; the agent's report IS the
 * comment. Cost / duration / numTurns are appended below the agent's report.
 */

const verdictSchema = z
  .object({
    valid: z.boolean(),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(500),
    recommendedNext: z.enum(["plan", "stop"]),
    evidence: z
      .array(
        z.object({
          file: z.string().min(1),
          line: z.number().int().nonnegative().optional(),
          note: z.string().min(1).optional(),
        }),
      )
      .default([]),
  })
  .strict();
type Verdict = z.infer<typeof verdictSchema>;

export const handler: WorkflowHandler = async (ctx) => {
  const { octokit, target, logger: log } = ctx;
  let cleanup: (() => Promise<void>) | undefined;

  try {
    if (target.type !== "issue") {
      return { status: "failed", reason: "triage requires issue target" };
    }

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

    const prompt = buildTriagePrompt({
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
      allowedTools: ["Read", "Grep", "Glob", "Bash", "Write"],
    });

    if (!result.success) {
      return { status: "failed", reason: "triage agent execution failed" };
    }

    const reportPath = join(checkout.workDir, "TRIAGE.md");
    const verdictPath = join(checkout.workDir, "TRIAGE_VERDICT.json");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const report = await readFile(reportPath, "utf8").catch(() => "");
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const verdictRaw = await readFile(verdictPath, "utf8").catch(() => "");

    if (report.trim().length === 0) {
      return { status: "failed", reason: "triage agent did not produce TRIAGE.md" };
    }
    if (verdictRaw.trim().length === 0) {
      return { status: "failed", reason: "triage agent did not produce TRIAGE_VERDICT.json" };
    }

    let verdict: Verdict;
    try {
      verdict = verdictSchema.parse(JSON.parse(verdictRaw));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", reason: `TRIAGE_VERDICT.json failed validation: ${message}` };
    }

    const humanMessage = composeComment(report, verdict, result);
    const state = {
      valid: verdict.valid,
      confidence: verdict.confidence,
      summary: verdict.summary,
      recommendedNext: verdict.recommendedNext,
      evidence: verdict.evidence,
      report,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    log.info(
      {
        valid: verdict.valid,
        confidence: verdict.confidence,
        evidenceCount: verdict.evidence.length,
        costUsd: result.costUsd,
      },
      "triage handler completed",
    );

    if (!verdict.valid) {
      // Fail-out so ship cascade halts at this step. The full report is in
      // the tracking comment; the reason carries the one-line summary that
      // ship surfaces in its own parent comment ("ship halted at step 0...").
      return {
        status: "failed",
        reason: `triage rejected as invalid: ${verdict.summary}`,
        state,
        humanMessage,
      };
    }

    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "triage handler caught error");
    return { status: "failed", reason: `triage failed: ${message}` };
  } finally {
    if (cleanup !== undefined) {
      await cleanup().catch((err: unknown) => {
        log.warn({ err }, "triage handler cleanup failed");
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

function buildTriagePrompt(input: {
  issueTitle: string;
  issueBody: string;
  owner: string;
  repo: string;
  number: number;
}): string {
  return [
    `You are a senior engineer triaging a GitHub issue against the actual codebase.`,
    `Your job is NOT to fix or plan — only to VALIDATE: is this issue accurate, reproducible, and worth pursuing as written?`,
    ``,
    `Repository: ${input.owner}/${input.repo}`,
    `Issue #${String(input.number)}: ${input.issueTitle}`,
    ``,
    `--- Issue body ---`,
    input.issueBody,
    `--- End issue body ---`,
    ``,
    `Method:`,
    `1. Read the issue carefully. Identify every claim it makes about the code (file paths, behaviours, bugs, missing features).`,
    `2. Use Read / Grep / Glob to inspect the actual code. Read the relevant files in full where claims are specific.`,
    `3. Cross-check each claim. Note evidence with file paths and line numbers.`,
    `4. Decide validity:`,
    `   - VALID = the issue accurately describes a real bug, missing feature, or improvement worth doing.`,
    `   - INVALID = the issue is wrong (already-fixed, misreads code, duplicates, out-of-scope, unclear, or unreproducible).`,
    `5. Write TRIAGE.md at the repo root with this structure (markdown):`,
    ``,
    `    # Triage: <issue title>`,
    `    ## Verdict`,
    `    **<VALID | INVALID>** (confidence: <0.0-1.0>)`,
    `    <one-paragraph summary>`,
    `    ## What was inspected`,
    `    - <file path> — <why you read it>`,
    `    ...`,
    `    ## Findings`,
    `    - <finding 1, with file:line citation>`,
    `    - <finding 2, with file:line citation>`,
    `    ...`,
    `    ## Reasoning`,
    `    <step-by-step argument that links findings to verdict>`,
    `    ## Recommended next step`,
    `    <"plan" if VALID, otherwise "stop" with one-sentence reason>`,
    ``,
    `6. Write TRIAGE_VERDICT.json at the repo root with the EXACT shape:`,
    ``,
    `    {`,
    `      "valid": true | false,`,
    `      "confidence": <0.0-1.0>,`,
    `      "summary": "<single line, ≤500 chars, no newlines>",`,
    `      "recommendedNext": "plan" | "stop",`,
    `      "evidence": [`,
    `        { "file": "<path>", "line": <int|omit>, "note": "<short>" },`,
    `        ...`,
    `      ]`,
    `    }`,
    ``,
    `Rules:`,
    `- Be ruthless about evidence. A claim without a file:line citation is a guess.`,
    `- If the issue is genuinely unclear, mark INVALID with recommendedNext="stop" and explain what's needed.`,
    `- Do NOT modify any source files. Do NOT make recommendations beyond "plan" or "stop". Do NOT write code.`,
    `- The two output files (TRIAGE.md, TRIAGE_VERDICT.json) are the only things you should write.`,
    `- When both files are saved, your job is done.`,
  ].join("\n");
}

function composeComment(
  report: string,
  verdict: Verdict,
  result: { costUsd?: number | undefined; numTurns?: number | undefined; durationMs?: number },
): string {
  const verdictLine = verdict.valid
    ? `✅ **Valid** — proceeding to next step (\`${verdict.recommendedNext}\`).`
    : `🛑 **Invalid** — chain halted (\`${verdict.recommendedNext}\`).`;
  const meta: string[] = [];
  if (result.costUsd !== undefined) meta.push(`cost: $${result.costUsd.toFixed(4)}`);
  if (result.numTurns !== undefined) meta.push(`turns: ${String(result.numTurns)}`);
  if (result.durationMs !== undefined)
    meta.push(`duration: ${String(Math.round(result.durationMs / 1000))}s`);
  const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";
  return `${verdictLine}\n\n${report.trim()}${metaLine}`;
}
