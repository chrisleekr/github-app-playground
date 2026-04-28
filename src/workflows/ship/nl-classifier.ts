/**
 * Natural-language trigger classifier (FR-025 + FR-025a). Single-turn
 * Bedrock call via the existing `src/ai/llm-client.ts` adaptor, gated
 * on the FR-025a mention-prefix check — comments without the configured
 * `TRIGGER_PHRASE` mention return `null` BEFORE the LLM is invoked
 * (zero LLM cost on conversational comments).
 *
 * Returns the canonical command shape:
 *   { intent: 'ship'|'stop'|'resume'|'abort'|'none', deadline_ms?: number }
 *
 * `intent: 'none'` is the explicit signal that no action is required
 * (e.g. `@chrisleekr-bot thanks for the help`). The caller MUST treat
 * `null` and `'none'` as zero-handler-invocation outcomes.
 */

import { z } from "zod";

import { logger } from "../../logger";
import type { CommandIntent } from "../../shared/ship-types";

export const NL_CLASSIFIER_RESULT = z.object({
  intent: z.enum(["ship", "stop", "resume", "abort", "none"]),
  deadline_ms: z.number().int().positive().optional(),
});

export type NlClassifierResult = z.infer<typeof NL_CLASSIFIER_RESULT>;

const SYSTEM_PROMPT = `You classify GitHub PR comments addressed to a code-shipping bot.
Return ONLY a single JSON object matching this schema and nothing else:
  { "intent": "ship"|"stop"|"resume"|"abort"|"none", "deadline_ms"?: number }
Use "ship" when the author wants the bot to drive the PR to merge-ready.
Use "stop" when the author wants the bot to pause (resumable).
Use "resume" when the author wants the bot to continue a paused session.
Use "abort" when the author wants the bot to terminate the session.
Use "none" when the comment does not address the bot or is conversational.
If the author specifies a duration ("2 hours", "30 mins"), include deadline_ms.`;

export interface ClassifyInput {
  readonly commentBody: string;
  readonly triggerPhrase: string;
  /** Injected so tests don't need a real Bedrock call. */
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export async function classifyComment(input: ClassifyInput): Promise<NlClassifierResult | null> {
  // FR-025a: only fire when the trigger phrase is the mention prefix.
  // `indexOf` would also match quoted/log-pasted text, which we explicitly
  // do not want to classify (and pay LLM tokens for).
  const trimmed = input.commentBody.trimStart();
  if (!trimmed.startsWith(input.triggerPhrase)) return null;
  const post = trimmed.slice(input.triggerPhrase.length).trim();
  if (post === "") return null;

  let raw: string;
  try {
    raw = await input.callLlm({ systemPrompt: SYSTEM_PROMPT, userPrompt: post });
  } catch (err) {
    logger.warn({ event: "ship.nl.llm_error", err: String(err) }, "ship nl-classifier LLM failed");
    return { intent: "none" };
  }

  const trimmedJson = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedJson);
  } catch {
    return { intent: "none" };
  }
  const validated = NL_CLASSIFIER_RESULT.safeParse(parsed);
  if (!validated.success) return { intent: "none" };
  return validated.data;
}

/** Narrow the classifier's `intent` enum to a `CommandIntent` (drops `'none'`). */
export function toCommandIntent(intent: NlClassifierResult["intent"]): CommandIntent | null {
  return intent === "none" ? null : intent;
}
