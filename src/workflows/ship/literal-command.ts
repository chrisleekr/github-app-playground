/**
 * Deterministic parser for the literal `bot:<verb>` PR-comment surface
 * (FR-018). Owns the regex grammar so the trigger router and webhook
 * dispatch share a single source of truth.
 *
 * Grammar (anchored, case-sensitive, evaluated per non-empty line of
 * the comment body — first match wins):
 *
 *   ^bot:(ship|stop|resume|abort-ship)(?:\s+--deadline\s+(\d+(?:\.\d+)?)(h|m|s))?\s*$
 *
 * Returns `null` for non-matching input, or a `{intent, deadline_ms?}`
 * record. Rejects malformed deadlines and deadlines beyond the
 * `MAX_WALL_CLOCK_PER_SHIP_RUN` env ceiling by returning `null` (the
 * caller surfaces the maintainer-facing tracking-comment reply).
 */

import { config } from "../../config";
import type { CommandIntent } from "../../shared/ship-types";

export interface LiteralCommand {
  readonly intent: CommandIntent;
  readonly deadline_ms?: number;
}

const VERB_TO_INTENT: Record<string, CommandIntent> = {
  ship: "ship",
  stop: "stop",
  resume: "resume",
  "abort-ship": "abort",
};

const COMMAND_PATTERN =
  /^bot:(ship|stop|resume|abort-ship)(?:\s+--deadline\s+(\d+(?:\.\d+)?)(h|m|s))?\s*$/;

export function parseLiteralCommand(commentBody: string): LiteralCommand | null {
  for (const rawLine of commentBody.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- match() reads cleaner; equivalent semantics
    const match = line.match(COMMAND_PATTERN);
    if (match === null) continue;
    const verb = match[1];
    const numericPart = match[2];
    const unit = match[3];
    if (verb === undefined) continue;
    const intent = VERB_TO_INTENT[verb];
    if (intent === undefined) continue;

    if (numericPart === undefined || unit === undefined) {
      return { intent };
    }
    const n = Number(numericPart);
    if (!Number.isFinite(n) || n <= 0) return null;
    const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    const deadlineMs = Math.round(n * mult);
    if (deadlineMs <= 0 || deadlineMs > config.maxWallClockPerShipRun) return null;
    return { intent, deadline_ms: deadlineMs };
  }
  return null;
}
