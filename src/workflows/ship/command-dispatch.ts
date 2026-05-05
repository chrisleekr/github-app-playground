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
import {
  type CanonicalCommand,
  type CanonicalCommandPr,
  isScopedCommandIntent,
  isShipCommandIntent,
} from "../../shared/ship-types";
import { getTriageLLMClient } from "../../webhook/triage-client-factory";
import { runLifecycleCommand } from "./lifecycle-commands";
import { dispatchScopedCommand, type ScopedCommandDeps } from "./scoped/dispatch-scoped";
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

  if (isShipCommandIntent(command.intent)) {
    // stop / resume / abort (T058, T058b).
    void runLifecycleCommand({ command, octokit: deps.octokit, log }).catch((err: unknown) => {
      log.error({ err }, "runLifecycleCommand threw");
    });
    return;
  }

  if (isScopedCommandIntent(command.intent)) {
    // US5 — fan out to the right scoped handler. Each scoped handler
    // is stateless (no `ship_intents` row) and runs to completion in a
    // single agent invocation.
    const scopedDeps: ScopedCommandDeps = { octokit: deps.octokit, log };
    void dispatchScopedCommand(command, scopedDeps).catch((err: unknown) => {
      log.error({ err }, "dispatchScopedCommand threw");
    });
    return;
  }

  log.warn("dispatchCanonicalCommand: unrecognised intent (no handler)");
}

/**
 * T028e dispatcher for comment surfaces (issue_comment +
 * pull_request_review_comment). Tries the literal `bot:<verb>` parser
 * first; on no match, falls back to the NL classifier (gated on
 * mention-prefix per FR-025a). Both paths produce a `CanonicalCommand`
 * via `routeTrigger(...)` — the NL classifier MUST NOT run when the
 * literal parser already matched (no double-fire).
 *
 * Returns `true` when canonical routing matched a verb and dispatched
 * a handler; `false` when neither the literal parser nor the NL
 * classifier produced an actionable intent. Callers use the return
 * value to decide whether to fall back to legacy dispatch.
 */
export async function dispatchCommentSurface(input: {
  readonly commentBody: string;
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
  /**
   * Per-event-surface eligibility carrier (FR-029..FR-035). When present,
   * it is forwarded verbatim into the canonical command. When absent
   * (legacy callers), per-intent eligibility is not enforced — every
   * 11-verb intent reaches its handler.
   */
  readonly event_surface?: "pr-comment" | "review-comment" | "issue-comment";
  /** Set when the comment originates from a `pull_request_review_comment`. */
  readonly thread_id?: string;
  readonly octokit: Octokit;
  readonly log?: Logger;
}): Promise<boolean> {
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
        ...(input.event_surface !== undefined ? { event_surface: input.event_surface } : {}),
        ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
      },
    });
    if (literal !== null) {
      dispatchCanonicalCommand(literal, deps);
      return true;
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
        ...(input.event_surface !== undefined ? { event_surface: input.event_surface } : {}),
        ...(input.thread_id !== undefined ? { thread_id: input.thread_id } : {}),
      },
    });
    if (nl !== null) {
      dispatchCanonicalCommand(nl, deps);
      return true;
    }
    return false;
  } catch (err) {
    // Anthropic SDK errors (the `callLlm` path above) wrap fetch Response
    // objects with circular refs that defeat pino's safe-stable-stringify
    // (`[unable to serialize, circular reference is too complex to analyze]`).
    // Match the same flat-string pattern used in `nl-classifier.ts:99` and
    // `intent-classifier.ts:143` so the actual API error stays visible.
    (input.log ?? rootLogger).error(
      {
        event: "ship.dispatch_comment_surface_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "ship dispatchCommentSurface threw — swallowed",
    );
    return false;
  }
}
