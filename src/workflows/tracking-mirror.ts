import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowName } from "./registry";
import {
  findById,
  mergeState,
  tryReserveTrackingCommentId,
  type WorkflowRunRow,
} from "./runs-store";

/**
 * FR-026: the tracking comment is a projection of `workflow_runs.state`, not
 * an independent record. `setState` writes the partial state and the
 * human-readable comment body in the same unit of work so they cannot drift.
 *
 * First call on a run creates the comment and records its id on the row.
 * Subsequent calls patch the same comment.
 */

export interface TrackingMirrorDeps {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
}

/**
 * Render the tracking-comment body from a workflow_runs row. Intentionally
 * plain: one line for the header (workflow + status) plus the caller's
 * human-readable message. Richer templating lands per-workflow if needed.
 */
export function renderCommentBody(row: WorkflowRunRow, humanMessage: string): string {
  const header = `**bot workflow \`${row.workflow_name}\`** — ${row.status}`;
  return `${header}\n\n${humanMessage}`;
}

export interface SetStateParams {
  readonly runId: string;
  readonly patch: Record<string, unknown>;
  readonly humanMessage: string;
}

/**
 * Merge `patch` into the row's state and update the tracking comment on
 * GitHub. Creates the comment on first call for the run. Returns the
 * post-merge row for callers that want to inspect the latest state.
 *
 * Ordering is DB-first so an API failure after the DB write re-tries cleanly
 * on the next setState call — the row is authoritative.
 */
export async function setState(
  deps: TrackingMirrorDeps,
  params: SetStateParams,
): Promise<WorkflowRunRow> {
  const { octokit, logger } = deps;
  const { runId, patch, humanMessage } = params;

  await mergeState(runId, patch);

  const row = await findById(runId);
  if (row === null) {
    throw new Error(`tracking-mirror.setState: run ${runId} not found after merge`);
  }

  const body = renderCommentBody(row, humanMessage);

  if (row.tracking_comment_id === null) {
    const created = await octokit.rest.issues.createComment({
      owner: row.target_owner,
      repo: row.target_repo,
      issue_number: row.target_number,
      body,
    });
    const reservation = await tryReserveTrackingCommentId(runId, created.data.id);
    if (reservation.won) {
      logger.info(
        { runId, commentId: created.data.id, workflowName: row.workflow_name },
        "Created tracking comment",
      );
      return { ...row, tracking_comment_id: created.data.id };
    }

    // Lost the race: another concurrent setState already reserved a comment.
    // Delete the duplicate we just created so a single canonical comment
    // remains. A delete failure is not fatal — the DB still points at the
    // winning comment, and the duplicate is cosmetic.
    logger.warn(
      {
        runId,
        losingCommentId: created.data.id,
        winningCommentId: reservation.trackingCommentId,
        workflowName: row.workflow_name,
      },
      "Lost tracking-comment reservation race; deleting duplicate comment",
    );
    try {
      await octokit.rest.issues.deleteComment({
        owner: row.target_owner,
        repo: row.target_repo,
        comment_id: created.data.id,
      });
    } catch (deleteErr) {
      logger.warn(
        {
          runId,
          losingCommentId: created.data.id,
          err: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        },
        "Failed to delete duplicate tracking comment",
      );
    }
    await octokit.rest.issues.updateComment({
      owner: row.target_owner,
      repo: row.target_repo,
      comment_id: reservation.trackingCommentId,
      body,
    });
    return { ...row, tracking_comment_id: reservation.trackingCommentId };
  }

  await octokit.rest.issues.updateComment({
    owner: row.target_owner,
    repo: row.target_repo,
    comment_id: row.tracking_comment_id,
    body,
  });
  return row;
}

/**
 * Dispatcher refusal helper — posts a one-off comment, no DB row needed.
 *
 * Best-effort: `createComment` failures are logged as warnings and swallowed,
 * mirroring the compensating-delete pattern above. The refusal comment is
 * purely cosmetic — the DB is already authoritative — so a transient GitHub
 * API blip must not bubble up into `dispatchByLabel` / `dispatchByIntent` and
 * surface as a webhook 500.
 */
export async function postRefusalComment(
  deps: TrackingMirrorDeps,
  target: { owner: string; repo: string; number: number },
  workflowName: WorkflowName | "unknown",
  reason: string,
): Promise<void> {
  const body = `**bot workflow \`${workflowName}\`** refused: ${reason}`;
  try {
    await deps.octokit.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      body,
    });
    deps.logger.info({ target, workflowName, reason }, "Posted workflow refusal comment");
  } catch (err) {
    deps.logger.warn(
      { target, workflowName, reason, err: err instanceof Error ? err.message : String(err) },
      "Failed to post workflow refusal comment — refusal remains authoritative in the DB",
    );
  }
}
