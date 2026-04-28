/**
 * Label-trigger surface (FR-026 + FR-026a). Deterministic parser for
 * the recognised label set + GraphQL self-removal helper. No LLM.
 *
 * Recognised labels:
 *   bot:ship                — start session (supports `/deadline=<duration>` suffix)
 *   bot:stop                — pause session
 *   bot:resume              — resume paused session
 *   bot:abort-ship          — terminal abort
 *
 * The bot self-removes the triggering label after acting (success,
 * ineligible, already-in-progress, unauthorised) so re-application is
 * the supported re-trigger mechanism.
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
};

const LABEL_PATTERN =
  /^(bot:(?:ship|stop|resume|abort-ship))(?:\/deadline=(\d+(?:\.\d+)?)(h|m|s))?$/;

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
 * a round trip; REST takes the label name directly). Idempotent — a
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
