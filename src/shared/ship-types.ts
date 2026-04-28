import { z } from "zod";

/**
 * Terminal session states for a `ship_intents` row. A session in any of
 * these states is finished — `terminated_at` is set, no further reactor
 * fan-out, no further iterations. The Postgres `ship_intents.status`
 * CHECK constraint is the union of these values plus the non-terminal
 * `'active'` and `'paused'` (FR-011 pause/resume cycle); see migration
 * `008_ship_intents.sql` (T005).
 *
 * `SessionStatus` (the full enum stored in the column) lives alongside
 * this list so consumers do not have to re-derive it.
 */
export const SESSION_TERMINAL_STATES = [
  "merged_externally",
  "ready_awaiting_human_merge",
  "deadline_exceeded",
  "human_took_over",
  "aborted_by_user",
  "pr_closed",
] as const;

export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];

export const SessionTerminalStateSchema = z.enum(SESSION_TERMINAL_STATES);

export function isSessionTerminalState(value: unknown): value is SessionTerminalState {
  return (
    typeof value === "string" && (SESSION_TERMINAL_STATES as readonly string[]).includes(value)
  );
}

/**
 * Full status enum for `ship_intents.status`: the terminal states above
 * plus the two non-terminal in-flight states `'active'` (currently
 * iterating or waiting) and `'paused'` (FR-011 pause/resume cycle —
 * non-terminal, can transition back to `'active'`).
 */
export const SESSION_STATUSES = ["active", "paused", ...SESSION_TERMINAL_STATES] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SessionStatusSchema = z.enum(SESSION_STATUSES);

/**
 * Reason why the bot handed control back to a human on a terminal
 * `human_took_over` intent. Stored on `ship_intents.terminal_blocker_category`
 * (NULL when the terminal state is self-explanatory, e.g. `deadline_exceeded`).
 *
 * Mapping from terminal state to required category lives in
 * `src/workflows/handlers/ship.ts` (T046).
 */
export const BLOCKER_CATEGORIES = [
  "design-discussion-needed",
  "manual-push-detected",
  "iteration-cap",
  "flake-cap",
  "merge-conflict-needs-human",
  "permission-denied",
  "stopped-by-user",
  "unrecoverable-error",
] as const;

export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];

export const BlockerCategorySchema = z.enum(BLOCKER_CATEGORIES);

export function isBlockerCategory(value: unknown): value is BlockerCategory {
  return typeof value === "string" && (BLOCKER_CATEGORIES as readonly string[]).includes(value);
}

// ─── Trigger surfaces (FR-018, FR-025/025a, FR-026/026a, FR-027) ─────────────

export const TRIGGER_SURFACES = ["literal", "nl", "label"] as const;
export type TriggerSurface = (typeof TRIGGER_SURFACES)[number];
export const TriggerSurfaceSchema = z.enum(TRIGGER_SURFACES);

export const COMMAND_INTENTS = ["ship", "stop", "resume", "abort"] as const;
export type CommandIntent = (typeof COMMAND_INTENTS)[number];
export const CommandIntentSchema = z.enum(COMMAND_INTENTS);

export interface CanonicalCommandPr {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly installation_id: number;
}

/**
 * The single canonical record produced by `trigger-router.routeTrigger(...)`
 * — every downstream handler reads commands in this shape regardless of
 * which surface (literal comment, natural-language, or GitHub label) the
 * maintainer used. The `surface` field exists for observability (FR-016)
 * only and MUST NOT influence eligibility, authorisation, or routing.
 */
export interface CanonicalCommand {
  readonly intent: CommandIntent;
  readonly deadline_ms?: number;
  readonly surface: TriggerSurface;
  readonly principal_login: string;
  readonly pr: CanonicalCommandPr;
}
