/**
 * Label-trigger surface (FR-026 + FR-026a + FR-029..FR-035). Deterministic
 * parser for the recognised label set + REST self-removal helper. No LLM.
 *
 * Recognised labels (10 total):
 *   Ship-lifecycle (4): write a `ship_intents` row:
 *     bot:ship               , start session (supports `/deadline=<duration>` suffix)
 *     bot:stop               , pause session
 *     bot:resume             , resume paused session
 *     bot:abort-ship         , terminal abort
 *
 *   Scoped one-shots (6): stateless single-action runs:
 *     bot:fix-thread         , mechanical fix on a review thread
 *     bot:summarize          , PR change-summary comment (idempotent marker)
 *     bot:rebase             , merge base into head; never force-push
 *     bot:investigate        , issue root-cause analysis (idempotent marker)
 *     bot:triage             , propose labels/severity/duplicates (suggest-only)
 *     bot:open-pr            , open a draft PR for an actionable issue
 *
 * The bot self-removes the triggering label after acting (success,
 * ineligible, already-in-progress, unauthorised) so re-application is
 * the supported re-trigger mechanism. This applies to all 11 labels.
 */

import type { Octokit } from "octokit";

import { config } from "../../config";
import type { CommandIntent } from "../../shared/ship-types";

export interface LabelCommand {
  readonly intent: CommandIntent;
  readonly deadline_ms?: number;
}

const LABEL_TO_INTENT: Record<string, CommandIntent> = {
  "bot:ship": "ship",
  "bot:stop": "stop",
  "bot:resume": "resume",
  "bot:abort-ship": "abort",
  "bot:fix-thread": "fix-thread",
  "bot:summarize": "summarize",
  "bot:rebase": "rebase",
  "bot:investigate": "investigate",
  "bot:triage": "triage",
  "bot:open-pr": "open-pr",
};

const LABEL_PATTERN =
  /^(bot:(?:ship|stop|resume|abort-ship|fix-thread|summarize|rebase|investigate|triage|open-pr))(?:\/deadline=(\d+(?:\.\d+)?)(h|m|s))?$/;

export function parseLabelTrigger(labelName: string): LabelCommand | null {
  const trimmed = labelName.trim();
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- match() reads cleaner; equivalent semantics
  const match = trimmed.match(LABEL_PATTERN);
  if (match === null) return null;
  const stem = match[1];
  if (stem === undefined) return null;
  const intent = LABEL_TO_INTENT[stem];
  if (intent === undefined) return null;
  const numericPart = match[2];
  const unit = match[3];
  if (numericPart === undefined || unit === undefined) return { intent };
  const n = Number(numericPart);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
  const deadlineMs = Math.round(n * mult);
  if (deadlineMs <= 0 || deadlineMs > config.maxWallClockPerShipRun) return null;
  return { intent, deadline_ms: deadlineMs };
}

export interface RemoveLabelInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly name: string;
}

/**
 * Self-remove the triggering label via REST (the GraphQL
 * `removeLabelsFromLabelable` requires the labelable node id which adds
 * a round trip; REST takes the label name directly). Idempotent: a
 * 404 is treated as already-removed.
 */
export async function removeLabel(input: RemoveLabelInput): Promise<void> {
  try {
    await input.octokit.rest.issues.removeLabel({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issue_number,
      name: input.name,
    });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 404) return;
    throw err;
  }
}
