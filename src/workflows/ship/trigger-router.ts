/**
 * Trigger router (T028a / FR-027). Single entry point producing the
 * `CanonicalCommand` record from any of the three trigger surfaces.
 * Returns `null` for non-actionable inputs.
 *
 * The `surface` field on the canonical record exists for observability
 * (FR-016) only — eligibility, authorisation, and routing MUST NOT
 * read it.
 */

import type { CanonicalCommand, CanonicalCommandPr, TriggerSurface } from "../../shared/ship-types";
import { parseLabelTrigger } from "./label-trigger";
import { parseLiteralCommand } from "./literal-command";
import { classifyComment, toCommandIntent } from "./nl-classifier";

interface BasePayload {
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
}

export interface LiteralPayload extends BasePayload {
  readonly commentBody: string;
}

export interface LabelPayload extends BasePayload {
  readonly label_name: string;
}

export interface NLPayload extends BasePayload {
  readonly commentBody: string;
  readonly triggerPhrase: string;
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

export type RouteInput =
  | { readonly surface: "literal"; readonly payload: LiteralPayload }
  | { readonly surface: "label"; readonly payload: LabelPayload }
  | { readonly surface: "nl"; readonly payload: NLPayload };

function withSurface(
  parsed: { intent: CanonicalCommand["intent"]; deadline_ms?: number },
  surface: TriggerSurface,
  payload: BasePayload,
): CanonicalCommand {
  const command: CanonicalCommand =
    parsed.deadline_ms === undefined
      ? {
          intent: parsed.intent,
          surface,
          principal_login: payload.principal_login,
          pr: payload.pr,
        }
      : {
          intent: parsed.intent,
          deadline_ms: parsed.deadline_ms,
          surface,
          principal_login: payload.principal_login,
          pr: payload.pr,
        };
  return command;
}

export async function routeTrigger(input: RouteInput): Promise<CanonicalCommand | null> {
  if (input.surface === "literal") {
    const parsed = parseLiteralCommand(input.payload.commentBody);
    if (parsed === null) return null;
    return withSurface(parsed, "literal", input.payload);
  }
  if (input.surface === "label") {
    const parsed = parseLabelTrigger(input.payload.label_name);
    if (parsed === null) return null;
    return withSurface(parsed, "label", input.payload);
  }
  // NL
  const result = await classifyComment({
    commentBody: input.payload.commentBody,
    triggerPhrase: input.payload.triggerPhrase,
    callLlm: input.payload.callLlm,
  });
  if (result === null) return null;
  const intent = toCommandIntent(result.intent);
  if (intent === null) return null;
  const parsed =
    result.deadline_ms === undefined ? { intent } : { intent, deadline_ms: result.deadline_ms };
  return withSurface(parsed, "nl", input.payload);
}
