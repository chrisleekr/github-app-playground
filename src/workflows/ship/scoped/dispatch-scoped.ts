/**
 * Scoped-command fan-out (US5 / T089-T091). Maps a `CanonicalCommand`
 * with a scoped intent (`fix-thread`, `explain-thread`, `summarize`,
 * `rebase`, `investigate`, `triage`, `open-pr`) to the appropriate
 * scoped handler. Each handler is stateless — no `ship_intents` row,
 * no tracking comment, no continuation. Failures are logged and
 * swallowed at the per-intent boundary so a misbehaving handler does
 * not poison the webhook delivery.
 *
 * The dispatcher centralises the LLM-call factory (Bedrock single-turn
 * via `src/ai/llm-client.ts`) so scoped handlers stay pure of
 * provider details.
 *
 * Two of the seven scoped commands — `fix-thread` and `rebase` —
 * require server-side git operations (clone + diff + push). Those are
 * delegated to a daemon-side helper that is NOT wired in v1; until
 * the helper lands, the dispatcher posts a maintainer-facing notice
 * explaining the limitation. The other five commands run in v1.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { resolveModelId } from "../../../ai/llm-client";
import { config } from "../../../config";
import type { CanonicalCommand } from "../../../shared/ship-types";
import { getTriageLLMClient } from "../../../webhook/triage-client-factory";
import { runInvestigate } from "./investigate";
import { runOpenPr } from "./open-pr";
import { runSummarize } from "./summarize";
import { runTriage } from "./triage";

export interface ScopedCommandDeps {
  readonly octokit: Octokit;
  readonly log?: Logger;
}

/**
 * Build the LLM-call adapter the scoped handlers expect. Reuses the
 * shared triage LLM client (Bedrock when configured, Anthropic otherwise)
 * to avoid spinning up a parallel SDK instance per command.
 */
function buildCallLlm(): (input: { systemPrompt: string; userPrompt: string }) => Promise<string> {
  const llm = getTriageLLMClient();
  const modelId = resolveModelId(config.triageModel, llm.provider);
  return async (params) => {
    const res = await llm.create({
      model: modelId,
      system: params.systemPrompt,
      messages: [{ role: "user", content: params.userPrompt }],
      maxTokens: 800,
      temperature: 0.1,
    });
    return res.text;
  };
}

async function postNotImplemented(
  deps: ScopedCommandDeps,
  command: CanonicalCommand,
  reason: string,
): Promise<void> {
  await deps.octokit.rest.issues.createComment({
    owner: command.pr.owner,
    repo: command.pr.repo,
    issue_number: command.pr.number,
    body: `\`bot:${command.intent}\` is recognised but not yet wired in this build (${reason}). The trigger-router accepted the command and the maintainer is being notified — no further action will be taken on this trigger.`,
  });
}

/**
 * Stateless one-shot dispatch. Each branch swallows handler errors
 * after logging so a misbehaving scoped command never crashes the
 * webhook delivery loop.
 */
export async function dispatchScopedCommand(
  command: CanonicalCommand,
  deps: ScopedCommandDeps,
): Promise<void> {
  const callLlm = buildCallLlm();
  switch (command.intent) {
    case "summarize":
      await runSummarize({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        pr_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "investigate":
      await runInvestigate({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "triage":
      await runTriage({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    case "open-pr": {
      // The branch+PR creation callback is not wired in v1 (the daemon-side
      // git helper that performs the actual `git checkout -b` + `gh pr create`
      // sequence is a follow-up — see comment at top of this file). Until
      // it lands, open-pr surfaces the maintainer-facing classifier verdict
      // without creating a PR.
      const createBranchAndPr = (): Promise<{
        pr_number: number;
        branch_name: string;
        pr_url: string;
      }> => {
        throw new Error("createBranchAndPr daemon-side helper not yet wired");
      };
      await runOpenPr({
        octokit: deps.octokit,
        owner: command.pr.owner,
        repo: command.pr.repo,
        issue_number: command.pr.number,
        callLlm,
        createBranchAndPr,
        ...(deps.log ? { log: deps.log } : {}),
      });
      return;
    }
    case "fix-thread":
      await postNotImplemented(
        deps,
        command,
        "needs the daemon-side mechanical-fix executor; tracked as a v1 follow-up",
      );
      return;
    case "explain-thread":
      await postNotImplemented(
        deps,
        command,
        "needs the daemon-side code-snippet resolver; tracked as a v1 follow-up",
      );
      return;
    case "rebase":
      await postNotImplemented(
        deps,
        command,
        "needs the daemon-side `git merge` runner; tracked as a v1 follow-up",
      );
      return;
    default: {
      // Defensive — exhaustiveness guard. A new scoped intent added to
      // SCOPED_COMMAND_INTENTS without a case here will fail the type
      // check.
      const _exhaustive: never = command.intent as never;
      void _exhaustive;
      (deps.log ?? undefined)?.warn(
        { intent: command.intent },
        "dispatchScopedCommand: unhandled scoped intent",
      );
    }
  }
}
