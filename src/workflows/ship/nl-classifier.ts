/**
 * Natural-language trigger classifier (FR-025 + FR-025a). Single-turn
 * Bedrock call via the existing `src/ai/llm-client.ts` adaptor, gated
 * on the FR-025a mention-prefix check — comments without the configured
 * `TRIGGER_PHRASE` mention return `null` BEFORE the LLM is invoked
 * (zero LLM cost on conversational comments).
 *
 * Returns the canonical command shape:
 *   { intent: 'ship'|'stop'|'resume'|'abort'|<scoped-verb>|'none', deadline_ms?: number }
 *
 * `intent: 'none'` is the explicit signal that no action is required
 * (e.g. `@chrisleekr-bot thanks for the help`, or a verb that is
 * ineligible on the current event surface — see FR-029..FR-035 +
 * `INTENT_ELIGIBLE_SURFACES` in `src/shared/ship-types.ts`). The caller
 * MUST treat `null` and `'none'` as zero-handler-invocation outcomes.
 */

import { z } from "zod";

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
    "explain-thread",
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
  { "intent": "ship"|"stop"|"resume"|"abort"|"fix-thread"|"explain-thread"|"summarize"|"rebase"|"investigate"|"triage"|"open-pr"|"none", "deadline_ms"?: number }
Ship-lifecycle verbs (only valid on PRs):
- "ship" — drive the PR to merge-ready.
- "stop" — pause (resumable).
- "resume" — continue a paused session.
- "abort" — terminate the session.
Scoped one-shot verbs (each declares which surfaces accept it):
- "fix-thread" — apply a mechanical fix to the targeted review thread (review-comment surface only).
- "explain-thread" — explain the code at the targeted review thread (review-comment surface only).
- "summarize" — post a structured PR change-summary (PR surfaces).
- "rebase" — merge the PR's base into its head (PR surfaces; never force-push).
- "investigate" — root-cause analysis on an issue (issue surfaces only).
- "triage" — propose labels/severity/duplicates on an issue, suggest-only (issue surfaces only).
- "open-pr" — open a draft PR for an actionable issue (issue surfaces only).
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
    raw = await input.callLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt: post });
  } catch (err) {
    logger.warn({ event: "ship.nl.llm_error", err: String(err) }, "ship nl-classifier LLM failed");
    return { intent: "none" };
  }

  // Strip a single leading ```/```json fence and trailing ``` if present.
  // Anthropic Haiku frequently wraps single-object JSON responses in a
  // markdown code block despite the system prompt asking for raw JSON;
  // without unwrapping, every NL trigger silently classifies as `none`.
  const trimmedJson = stripJsonFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedJson);
  } catch {
    return { intent: "none" };
  }
  const validated = NL_CLASSIFIER_RESULT.safeParse(parsed);
  if (!validated.success) return { intent: "none" };

  // Per-event-surface eligibility (FR-029..FR-035): a verb that is not
  // eligible on the current event surface is rewritten to `'none'`. We
  // do this post-classification rather than via the prompt because LLM
  // adherence to surface rules is unreliable; deterministic enforcement
  // is the contract.
  if (input.eventSurface !== undefined && validated.data.intent !== "none") {
    if (!isIntentEligibleOnSurface(validated.data.intent, input.eventSurface)) {
      return { intent: "none" };
    }
  }

  return validated.data;
}

/** Narrow the classifier's `intent` enum to a `CommandIntent` (drops `'none'`). */
export function toCommandIntent(intent: NlClassifierResult["intent"]): CommandIntent | null {
  return intent === "none" ? null : intent;
}

/**
 * Strip a single leading and trailing markdown code fence from an LLM
 * response so the inner JSON can be parsed.
 *
 * Anthropic Haiku 4.5 — the model `TRIAGE_MODEL` defaults to — frequently
 * answers with a fenced block (```json …```) even when the system prompt
 * says "Return ONLY a single JSON object". Without unwrapping, every NL
 * trigger silently classified as `none` and fell through to the legacy
 * intent classifier (which routes ship to issues only). Surfaced by T042
 * S2 against `@chrisleekr-bot-dev`.
 *
 * Conservative: only strips when both leading and trailing fences are
 * present; passes through unfenced JSON unchanged.
 */
export function stripJsonFence(text: string): string {
  const fencePattern = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const fenceMatch = fencePattern.exec(text);
  return fenceMatch?.[1] ?? text;
}
