import type { ZodType } from "zod";

import { parseTolerantJson } from "../utils/tolerant-json";

/**
 * Structured-output pipeline.
 *
 * Centralises the "ask the LLM for JSON, parse, and validate" mechanism
 * so the seven call sites that need it stop duplicating fragile parser
 * code. Mechanism / policy split: this module owns parse + validate;
 * each caller owns what failure means for its execution path.
 *
 * Pure module — no LLM client coupling, no I/O.
 *
 * Pipeline:
 *   raw string  ->  strip code fence  ->  strict JSON.parse
 *                                          | on fail
 *                                          v
 *                                     tolerant JSON.parse
 *                                     (escapes raw LF/CR/TAB inside
 *                                     string values, then retries)
 *                                          | on fail
 *                                          v
 *                                  StructuredResult { ok: false, stage: "parse" }
 *                                          |
 *                                          v on parse success
 *                                   schema.safeParse
 *                                          | on validation fail
 *                                          v
 *                                  StructuredResult { ok: false, stage: "validate" }
 *                                          | on validation success
 *                                          v
 *                                  StructuredResult { ok: true, data, strategy }
 */

/**
 * Encoding rules appended to a caller's system prompt to nudge models
 * toward valid JSON. Belt-and-braces with the tolerant parser: prompt
 * nudge is the cheap-when-it-works defense; tolerant parser is the
 * deterministic catch-all.
 */
export const STRUCTURED_OUTPUT_RULES = `JSON encoding rules (CRITICAL — your output is parsed by JSON.parse):
- Inside string values, escape newlines as \\n (backslash + n), tabs as \\t, backslashes as \\\\, quotes as \\".
- Do NOT emit literal newlines or tabs inside string values — that produces invalid JSON.
- Return EXACTLY one JSON object. No prose, no commentary, no code fences.`;

/**
 * Discriminated result from `parseStructuredResponse`. Callers MUST
 * switch on `ok` (and, for failures, on `stage`) — the type system
 * guarantees no field is silently undefined.
 */
export type StructuredResult<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly raw: string;
      readonly strategy: "strict" | "tolerant";
    }
  | {
      readonly ok: false;
      readonly stage: "parse";
      readonly raw: string;
      readonly error: string;
    }
  | {
      readonly ok: false;
      readonly stage: "validate";
      readonly raw: string;
      readonly error: string;
      readonly parsed: unknown;
    };

/**
 * Append `STRUCTURED_OUTPUT_RULES` to a caller's system prompt.
 *
 * Idempotent: if the rules block is already present, the input is
 * returned unchanged. Lets callers wrap defensively without worrying
 * about double-appending.
 */
export function withStructuredRules(systemPrompt: string): string {
  if (systemPrompt.includes(STRUCTURED_OUTPUT_RULES)) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${STRUCTURED_OUTPUT_RULES}`;
}

/**
 * Parse and validate an LLM string response as a typed structured object.
 *
 * Strips a single leading/trailing markdown code fence (``` or ```json)
 * before parsing — Anthropic Haiku-class models frequently wrap JSON in
 * fences despite "no fences" instructions.
 *
 * Returns a discriminated result; never throws.
 */
export function parseStructuredResponse<T>(raw: string, schema: ZodType<T>): StructuredResult<T> {
  const candidate = stripJsonFence(raw.trim());

  let parsed: unknown;
  let strategy: "strict" | "tolerant";

  try {
    parsed = JSON.parse(candidate);
    strategy = "strict";
  } catch {
    try {
      parsed = parseTolerantJson(candidate);
      strategy = "tolerant";
    } catch (err) {
      return {
        ok: false,
        stage: "parse",
        raw,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      stage: "validate",
      raw,
      error: validated.error.message,
      parsed,
    };
  }

  return { ok: true, data: validated.data, raw, strategy };
}

/**
 * Strip a single leading + trailing markdown code fence if both are present.
 * Conservative: passes unfenced text through unchanged. Tolerates fences
 * with or without leading/trailing newlines around the content.
 */
export function stripJsonFence(text: string): string {
  const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/;
  const match = fencePattern.exec(text);
  return match?.[1] ?? text;
}
