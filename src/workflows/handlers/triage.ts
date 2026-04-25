import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { checkoutRepo } from "../../core/checkout";
import { executeAgent } from "../../core/executor";
import type { BotContext } from "../../types";
import type { WorkflowHandler } from "../registry";

/**
 * `triage` handler — code-aware validation of an issue against the actual
 * repository state, with mandatory reproduction for bug-class issues.
 *
 * The handler:
 *   1. Fetches the issue title + body via Octokit.
 *   2. Clones the repository to a temp working directory.
 *   3. Runs Claude Agent SDK with read+execute tools (Read/Grep/Glob/Bash/
 *      Write) and instructs the agent to: classify the issue, search
 *      relevant source, ACTUALLY REPRODUCE the bug (if it claims one) by
 *      running the failing case, decide validity, and emit two artefacts
 *      at the repo root — `TRIAGE.md` (human-readable report, becomes the
 *      tracking comment body) and `TRIAGE_VERDICT.json` (machine-readable
 *      verdict).
 *   4. Parses `TRIAGE_VERDICT.json`. When `valid === false` the handler
 *      returns `failed` with the verdict summary as the reason — this
 *      halts a parent `ship` cascade at the triage step (see
 *      `workflows/orchestrator.ts onStepComplete`).
 *   5. The full `TRIAGE.md` report is the tracking comment body so the user
 *      sees evidence, reasoning, and reproduction details — not a one-liner.
 *
 * Reproduction: there is NO turn cap. A senior engineer's job is to
 * determine whether a reported bug is real; that requires running the code,
 * not just reading it. If reproduction is impossible (e.g., production-only,
 * needs external services we lack), the agent reports
 * `attempted: true, reproduced: null` with honest details — never lies.
 * Non-bug issues (features, refactors, docs) skip reproduction with
 * `attempted: false`.
 *
 * The handler does NOT post chat-style summaries; the agent's report IS the
 * comment. Cost / duration / numTurns are appended below the agent's report.
 */

const reproductionSchema = z
  .object({
    /**
     * `attempted=false` means the agent decided the issue is not a bug
     * claim (feature request, refactor proposal, doc fix). `attempted=true`
     * means the agent ran code to validate the bug.
     */
    attempted: z.boolean(),
    /**
     * `null` when `attempted === false` (nothing to reproduce). When
     * `attempted === true`: `true` = bug confirmed by running code,
     * `false` = code runs cleanly and the bug as described does not occur.
     * The agent uses `null` only when reproduction was attempted but
     * couldn't reach a verdict (e.g., needs production data we lack) —
     * in that case `details` MUST explain the obstacle honestly.
     */
    reproduced: z.boolean().nullable(),
    /**
     * What the agent did and observed. For non-bug issues, a one-liner
     * explaining why reproduction was skipped. For attempted reproductions,
     * commands run, output snippets, and the verdict.
     */
    details: z.string().min(1).max(2000),
  })
  .strict();

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
    reproduction: reproductionSchema,
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
      reproduction: verdict.reproduction,
      report,
      costUsd: result.costUsd ?? 0,
      turns: result.numTurns ?? 0,
    };

    log.info(
      {
        valid: verdict.valid,
        confidence: verdict.confidence,
        evidenceCount: verdict.evidence.length,
        reproductionAttempted: verdict.reproduction.attempted,
        reproduced: verdict.reproduction.reproduced,
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
    `1. **Classify the issue.** Read it carefully and decide which class it falls into:`,
    `   - **bug** — claims that something currently broken / incorrect / failing.`,
    `   - **feature** — asks for new capability that doesn't exist.`,
    `   - **refactor** — asks to restructure existing code without behaviour change.`,
    `   - **docs** — asks for documentation only.`,
    `   - **question/unclear** — not actionable without more info.`,
    ``,
    `2. **Inspect the code.** Use Read / Grep / Glob to find relevant files. Read them in full where claims are specific. Note evidence with file:line citations.`,
    ``,
    `3. **Reproduce (BUG ISSUES ONLY).** This is the senior-developer step the bot exists to perform. If the issue is class **bug**:`,
    `   a. Identify the smallest command that should expose the bug. Usually one of:`,
    `      \`bun test path/to/specific.test.ts\` (existing failing test)`,
    `      \`bun run typecheck\` / \`bun run lint\` (compile/style failure)`,
    `      a fresh test you write in /tmp that exercises the claimed behaviour`,
    `      a CLI invocation, REST request, or repo-local script the issue describes`,
    `   b. Run it via Bash. Capture the output.`,
    `   c. Decide:`,
    `      \`reproduced=true\`  → output matches the issue's claim. The bug is real.`,
    `      \`reproduced=false\` → code runs cleanly / output contradicts the claim. The issue is wrong (already-fixed, misread, environment-only) — mark VALID=false.`,
    `      \`reproduced=null\`  → reproduction was honestly attempted but couldn't reach a verdict (needs prod data, external service we don't have, race condition we can't trigger). Explain in detail.`,
    `   d. There is NO turn cap. Take as many turns as you need. If reproduction needs you to write a temporary test file in /tmp, install a dependency, or read additional code — do it. The cost of a thorough triage is far smaller than the cost of planning + implementing a non-bug.`,
    ``,
    `   For non-bug classes (feature/refactor/docs/unclear): set \`attempted=false\`, \`reproduced=null\`, \`details\` to a one-liner explaining why reproduction was skipped.`,
    ``,
    `4. **Decide validity.**`,
    `   - VALID = bug confirmed by reproduction, OR feature/refactor/docs ask is sensible and actionable as written.`,
    `   - INVALID = bug not reproducible (and not a "needs prod data" honest failure), or the issue misreads the code, duplicates an existing one, is out-of-scope, or genuinely unclear.`,
    ``,
    `5. **Write TRIAGE.md** at the repo root with this structure (markdown):`,
    ``,
    `    # Triage: <issue title>`,
    `    ## Verdict`,
    `    **<VALID | INVALID>** (confidence: <0.0-1.0>)`,
    `    <one-paragraph summary>`,
    `    ## What was inspected`,
    `    - <file path> — <why you read it>`,
    `    ...`,
    `    ## Reproduction`,
    `    <If bug class: the command(s) you ran, the output you saw, and your conclusion.`,
    `     If non-bug class: "Not a bug claim — reproduction skipped." plus one sentence why.`,
    `     Be specific. A senior reviewer should be able to re-run your steps verbatim.>`,
    `    ## Findings`,
    `    - <finding 1, with file:line citation>`,
    `    - <finding 2, with file:line citation>`,
    `    ...`,
    `    ## Reasoning`,
    `    <step-by-step argument that links findings + reproduction outcome to verdict>`,
    `    ## Recommended next step`,
    `    <"plan" if VALID, otherwise "stop" with one-sentence reason>`,
    ``,
    `6. **Write TRIAGE_VERDICT.json** at the repo root with the EXACT shape:`,
    ``,
    `    {`,
    `      "valid": true | false,`,
    `      "confidence": <0.0-1.0>,`,
    `      "summary": "<single line, ≤500 chars, no newlines>",`,
    `      "recommendedNext": "plan" | "stop",`,
    `      "evidence": [`,
    `        { "file": "<path>", "line": <int|omit>, "note": "<short>" },`,
    `        ...`,
    `      ],`,
    `      "reproduction": {`,
    `        "attempted": true | false,`,
    `        "reproduced": true | false | null,`,
    `        "details": "<≤2000 chars; commands run + output + conclusion, OR 'Not a bug claim' for non-bugs>"`,
    `      }`,
    `    }`,
    ``,
    `Rules:`,
    `- Be ruthless about evidence. A claim without a file:line citation is a guess.`,
    `- For bug issues, a verdict without an honest reproduction attempt is a failure of your job.`,
    `- It is OK to report \`reproduced=null\` if the bug genuinely can't be reproduced in this environment — but you MUST explain WHY honestly. Never lie about reproduction status.`,
    `- Do NOT modify any source files in the repo (writing temporary scripts under /tmp is fine; running tests is fine; do not stage or commit anything).`,
    `- Do NOT make recommendations beyond "plan" or "stop". Do NOT write code that fixes the issue.`,
    `- The two output files (TRIAGE.md, TRIAGE_VERDICT.json) are the only artefacts you should leave at the repo root.`,
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
