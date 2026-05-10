/**
 * Natural-language trigger classifier (FR-025 + FR-025a). Single-turn
 * Bedrock call via the existing `src/ai/llm-client.ts` adaptor, gated
 * on the FR-025a mention-prefix check: comments without the configured
 * `TRIGGER_PHRASE` mention return `null` BEFORE the LLM is invoked
 * (zero LLM cost on conversational comments).
 *
 * Returns the canonical command shape:
 *   { intent: 'ship'|'stop'|'resume'|'abort'|<scoped-verb>|'none', deadline_ms?: number }
 *
 * `intent: 'none'` is the explicit signal that no action is required
 * (e.g. `@chrisleekr-bot thanks for the help`, or a verb that is
 * ineligible on the current event surface: see FR-029..FR-035 +
 * `INTENT_ELIGIBLE_SURFACES` in `src/shared/ship-types.ts`). The caller
 * MUST treat `null` and `'none'` as zero-handler-invocation outcomes.
 */

import { z } from "zod";

import { parseStructuredResponse, withStructuredRules } from "../../ai/structured-output";
import { logger } from "../../logger";
import {
  type CommandIntent,
  type EventSurface,
  isIntentEligibleOnSurface,
} from "../../shared/ship-types";

export const NL_CLASSIFIER_RESULT = z.object({
  intent: z.enum([
    "ship",
    "stop",
    "resume",
    "abort",
    "fix-thread",
    "chat-thread",
    "summarize",
    "rebase",
    "investigate",
    "triage",
    "open-pr",
    "none",
  ]),
  deadline_ms: z.number().int().positive().optional(),
});

export type NlClassifierResult = z.infer<typeof NL_CLASSIFIER_RESULT>;

const SYSTEM_PROMPT = `You classify GitHub comments addressed to a maintainer bot.
Return ONLY a single JSON object matching this schema and nothing else:
  { "intent": "ship"|"stop"|"resume"|"abort"|"fix-thread"|"chat-thread"|"summarize"|"rebase"|"investigate"|"triage"|"open-pr"|"none", "deadline_ms"?: number }
Ship-lifecycle verbs (only valid on PRs):
- "ship": drive the PR to merge-ready.
- "stop": pause (resumable).
- "resume": continue a paused session.
- "abort": terminate the session.
Scoped one-shot verbs (each declares which surfaces accept it):
- "fix-thread": apply a mechanical fix to the targeted review thread (review-comment surface only).
- "chat-thread": have a freeform conversation: answer questions, explain code, propose follow-up actions (open issue, resolve thread), or propose a workflow when the ask is ambiguous. Always pick this for any reply-mention that is conversational rather than a clear command, including any explanation request (the explain-thread response style is a special case of chat-thread answer-mode). Eligible on review-comment, pr-comment, and issue-comment surfaces.
- "summarize": post a structured PR change-summary (PR surfaces).
- "rebase": merge the PR's base into its head (PR surfaces; never force-push).
- "investigate": root-cause analysis on an issue (issue surfaces only).
- "triage": propose labels/severity/duplicates on an issue, suggest-only (issue surfaces only).
- "open-pr": open a draft PR for an actionable issue (issue surfaces only).
Use "none" when the comment does not address the bot, is conversational, or names a verb that is not eligible on the current event surface.
If the author specifies a duration ("2 hours", "30 mins"), include deadline_ms.`;

export interface ClassifyInput {
  readonly commentBody: string;
  readonly triggerPhrase: string;
  /**
   * Webhook event surface where the comment arrived (per-intent
   * eligibility per FR-029..FR-035). When provided, an intent that is
   * ineligible on this surface is rewritten to `'none'` post-classification
   * so the caller does not invoke a handler that would refuse anyway.
   */
  readonly eventSurface?: EventSurface;
  /** Injected so tests don't need a real Bedrock call. */
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export async function classifyComment(input: ClassifyInput): Promise<NlClassifierResult | null> {
  // FR-025a: only fire when the trigger phrase is the mention prefix.
  // `indexOf` would also match quoted/log-pasted text, which we explicitly
  // do not want to classify (and pay LLM tokens for).
  const trimmed = input.commentBody.trimStart();
  if (!trimmed.startsWith(input.triggerPhrase)) return null;
  // Require a token boundary after the prefix so a longer login that
  // happens to share the same prefix (e.g. `@chrisleekr-bot-foo` vs
  // `@chrisleekr-bot`) does not slip through. Permitted boundaries:
  // end-of-string, whitespace, or common punctuation.
  const nextChar = trimmed[input.triggerPhrase.length];
  if (nextChar !== undefined && !/[\s:;,!.?)]/.test(nextChar)) return null;
  const post = trimmed.slice(input.triggerPhrase.length).trim();
  if (post === "") return null;

  let raw: string;
  try {
    raw = await input.callLlm({
      systemPrompt: withStructuredRules(SYSTEM_PROMPT),
      userPrompt: post,
    });
  } catch (err) {
    logger.warn({ event: "ship.nl.llm_error", err: String(err) }, "ship nl-classifier LLM failed");
    return { intent: "none" };
  }

  const result = parseStructuredResponse(raw, NL_CLASSIFIER_RESULT);
  if (!result.ok) {
    logger.warn(
      { event: "ship.nl.parse_error", stage: result.stage, error: result.error },
      "ship nl-classifier rejected response, returning intent=none",
    );
    return { intent: "none" };
  }

  // Per-event-surface eligibility (FR-029..FR-035): a verb that is not
  // eligible on the current event surface is rewritten to `'none'`. We
  // do this post-classification rather than via the prompt because LLM
  // adherence to surface rules is unreliable; deterministic enforcement
  // is the contract.
  if (input.eventSurface !== undefined && result.data.intent !== "none") {
    if (!isIntentEligibleOnSurface(result.data.intent, input.eventSurface)) {
      return { intent: "none" };
    }
  }

  return result.data;
}

/** Narrow the classifier's `intent` enum to a `CommandIntent` (drops `'none'`). */
export function toCommandIntent(intent: NlClassifierResult["intent"]): CommandIntent | null {
  return intent === "none" ? null : intent;
}
