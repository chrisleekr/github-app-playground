import type { Octokit } from "octokit";
import type pino from "pino";

const BOT_LABEL_PATTERN = /^bot:[a-z]+$/;

export interface EnforceSingleBotLabelParams {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  /** The bot:* label just applied that should be kept. */
  readonly justApplied: string;
  readonly logger: pino.Logger;
}

export interface EnforceResult {
  readonly kept: string;
  readonly removed: string[];
}

/**
 * FR-014 label mutex: keep exactly one `bot:*` label on an issue/PR. Any
 * other `bot:*` label currently present is removed. Non-bot labels are
 * untouched.
 *
 * Returns the kept label (equal to `justApplied`) and the list of labels
 * removed. A structured log line is emitted once per removal with
 * `reason: "bot-label-mutex"` for audit.
 *
 * Silently swallows a per-label removal failure (e.g. the label was already
 * removed by a concurrent webhook) because the mutex is best-effort —
 * dispatch still proceeds with the newly-applied label.
 */
export async function enforceSingleBotLabel(
  params: EnforceSingleBotLabelParams,
): Promise<EnforceResult> {
  const { octokit, owner, repo, number, justApplied, logger } = params;

  const response = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });

  const others = response.data
    .map((l) => l.name)
    .filter((name) => BOT_LABEL_PATTERN.test(name) && name !== justApplied);

  const removed: string[] = [];

  for (const label of others) {
    try {
      // eslint-disable-next-line no-await-in-loop -- serial removal is fine at ≤ a handful of labels
      await octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: number,
        name: label,
      });
      removed.push(label);
      logger.info(
        { owner, repo, number, removed: label, kept: justApplied, reason: "bot-label-mutex" },
        "Removed sibling bot label",
      );
    } catch (err) {
      logger.warn(
        {
          owner,
          repo,
          number,
          label,
          err: err instanceof Error ? err.message : String(err),
          reason: "bot-label-mutex",
        },
        "Failed to remove sibling bot label — continuing",
      );
    }
  }

  return { kept: justApplied, removed };
}
