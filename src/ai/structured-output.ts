import type pino from "pino";
import type { ZodType } from "zod";

import { redactErrorMessage } from "../utils/log-redaction";
import { parseTolerantJson } from "../utils/tolerant-json";
import { STRUCTURED_OUTPUT_EVENTS } from "./structured-output-log-fields";

/**
 * Structured-output pipeline.
 *
 * Centralises the "ask the LLM for JSON, parse, and validate" mechanism
 * so the seven call sites that need it stop duplicating fragile parser
 * code. Mechanism / policy split: this module owns parse + validate;
 * each caller owns what failure means for its execution path.
 *
 * Pure module: no LLM client coupling, no I/O.
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
export const STRUCTURED_OUTPUT_RULES = `JSON encoding rules (CRITICAL, your output is parsed by JSON.parse):
- Inside string values, escape newlines as \\n (backslash + n), tabs as \\t, backslashes as \\\\, quotes as \\".
- Do NOT emit literal newlines or tabs inside string values: that produces invalid JSON.
- Return EXACTLY one JSON object. No prose, no commentary, no code fences.`;

/**
 * Discriminated result from `parseStructuredResponse`. Callers MUST
 * switch on `ok` (and, for failures, on `stage`): the type system
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
 * Optional emit context. When supplied, the chokepoint fires one
 * `structured_output.*` event per call so every site reports the same field
 * shape (issue #233); `site` is the call-site discriminator. Sites that omit
 * it still get a `StructuredResult` with no log line.
 */
export interface StructuredOutputLogContext {
  readonly site: string;
  readonly log: pino.Logger;
}

/** JSON shape of a parsed value, for the `validate_failed` event. */
function parsedKind(value: unknown): "object" | "array" | "primitive" {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "primitive";
}

/**
 * Parse and validate an LLM string response as a typed structured object.
 *
 * Strips a single leading/trailing markdown code fence (``` or ```json)
 * before parsing: Anthropic Haiku-class models frequently wrap JSON in
 * fences despite "no fences" instructions.
 *
 * Returns a discriminated result; never throws.
 */
export function parseStructuredResponse<T>(
  raw: string,
  schema: ZodType<T>,
  ctx?: StructuredOutputLogContext,
): StructuredResult<T> {
  const startedAt = Date.now();
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
      const error = err instanceof Error ? err.message : String(err);
      ctx?.log.warn(
        {
          event: STRUCTURED_OUTPUT_EVENTS.parseFailed,
          site: ctx.site,
          raw_len: raw.length,
          parse_ms: Date.now() - startedAt,
          error: redactErrorMessage(error),
        },
        "structured-output: parse failed",
      );
      return { ok: false, stage: "parse", raw, error };
    }
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    ctx?.log.warn(
      {
        event: STRUCTURED_OUTPUT_EVENTS.validateFailed,
        site: ctx.site,
        raw_len: raw.length,
        parse_ms: Date.now() - startedAt,
        error: redactErrorMessage(validated.error.message),
        parsed_kind: parsedKind(parsed),
      },
      "structured-output: validation failed",
    );
    return {
      ok: false,
      stage: "validate",
      raw,
      error: validated.error.message,
      parsed,
    };
  }

  ctx?.log.info(
    {
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: ctx.site,
      raw_len: raw.length,
      parse_ms: Date.now() - startedAt,
      strategy,
    },
    "structured-output: parsed",
  );
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
