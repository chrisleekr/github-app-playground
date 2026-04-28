/**
 * Dispatch shim from `trigger-router.routeTrigger(...)` (T028a) output to
 * the appropriate handler in `src/workflows/handlers/`. The `ship`
 * intent is wired to `runShipFromCommand` (T028); `stop` / `resume` /
 * `abort` log only until US4 (T058a/b) wires their handlers.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { resolveModelId } from "../../ai/llm-client";
import { config } from "../../config";
import { logger as rootLogger } from "../../logger";
import type { CanonicalCommand, CanonicalCommandPr } from "../../shared/ship-types";
import { getTriageLLMClient } from "../../webhook/triage-client-factory";
import { runLifecycleCommand } from "./lifecycle-commands";
import { runShipFromCommand } from "./session-runner";
import { routeTrigger } from "./trigger-router";

export interface DispatchDeps {
  readonly octokit: Octokit;
  readonly log?: Logger;
}

export function dispatchCanonicalCommand(command: CanonicalCommand, deps: DispatchDeps): void {
  const log = (deps.log ?? rootLogger).child({
    event: "ship.command.dispatched",
    intent: command.intent,
    surface: command.surface,
    principal_login: command.principal_login,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    installation_id: command.pr.installation_id,
    deadline_ms: command.deadline_ms,
  });

  if (command.intent === "ship") {
    void runShipFromCommand({ command, octokit: deps.octokit, log }).catch((err: unknown) => {
      log.error({ err }, "runShipFromCommand threw");
    });
    return;
  }

  // stop / resume / abort (T058, T058b).
  void runLifecycleCommand({ command, octokit: deps.octokit, log }).catch((err: unknown) => {
    log.error({ err }, "runLifecycleCommand threw");
  });
}

/**
 * T028e dispatcher for comment surfaces (issue_comment +
 * pull_request_review_comment). Tries the literal `bot:<verb>` parser
 * first; on no match, falls back to the NL classifier (gated on
 * mention-prefix per FR-025a). Both paths produce a `CanonicalCommand`
 * via `routeTrigger(...)` — the NL classifier MUST NOT run when the
 * literal parser already matched (no double-fire).
 *
 * Caller must check `config.shipUseTriggerSurfacesV2` before invoking;
 * this function trusts the flag was on.
 */
export async function dispatchCommentSurface(input: {
  readonly commentBody: string;
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
  readonly octokit: Octokit;
  readonly log?: Logger;
}): Promise<void> {
  const deps: DispatchDeps = { octokit: input.octokit, ...(input.log ? { log: input.log } : {}) };
  // Wrap parser + classifier in a single guard. The literal parser is
  // synchronous-ish, but `routeTrigger("nl")` makes a remote LLM call which
  // can throw on Bedrock outages. Letting that bubble out of the webhook
  // handler causes 5xx + delivery retries; we log and swallow instead so
  // a transient classifier outage doesn't double-deliver work.
  try {
    // 1. Literal-first.
    const literal = await routeTrigger({
      surface: "literal",
      payload: {
        commentBody: input.commentBody,
        principal_login: input.principal_login,
        pr: input.pr,
      },
    });
    if (literal !== null) {
      dispatchCanonicalCommand(literal, deps);
      return;
    }

    // 2. NL fallback. Mention-prefix gate (FR-025a) lives in classifier.
    const llm = getTriageLLMClient();
    const modelId = resolveModelId(config.triageModel, llm.provider);
    const callLlm = async (params: {
      systemPrompt: string;
      userPrompt: string;
    }): Promise<string> => {
      const res = await llm.create({
        model: modelId,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.userPrompt }],
        maxTokens: 256,
        temperature: 0,
      });
      return res.text;
    };

    const nl = await routeTrigger({
      surface: "nl",
      payload: {
        commentBody: input.commentBody,
        triggerPhrase: config.triggerPhrase,
        principal_login: input.principal_login,
        pr: input.pr,
        callLlm,
      },
    });
    if (nl !== null) dispatchCanonicalCommand(nl, deps);
  } catch (err) {
    (input.log ?? rootLogger).error(
      { event: "ship.dispatch_comment_surface_failed", err: String(err) },
      "ship dispatchCommentSurface threw — swallowed",
    );
  }
}
