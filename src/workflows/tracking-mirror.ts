import type { Octokit } from "octokit";
import type pino from "pino";

import type { WorkflowName } from "./registry";
import { findById, mergeState, setTrackingCommentId, type WorkflowRunRow } from "./runs-store";

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
    await setTrackingCommentId(runId, created.data.id);
    logger.info(
      { runId, commentId: created.data.id, workflowName: row.workflow_name },
      "Created tracking comment",
    );
    return { ...row, tracking_comment_id: created.data.id };
  }

  await octokit.rest.issues.updateComment({
    owner: row.target_owner,
    repo: row.target_repo,
    comment_id: row.tracking_comment_id,
    body,
  });
  return row;
}

/** Dispatcher refusal helper — posts a one-off comment, no DB row needed. */
export async function postRefusalComment(
  deps: TrackingMirrorDeps,
  target: { owner: string; repo: string; number: number },
  workflowName: WorkflowName | "unknown",
  reason: string,
): Promise<void> {
  const body = `**bot workflow \`${workflowName}\`** refused: ${reason}`;
  await deps.octokit.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.number,
    body,
  });
  deps.logger.info({ target, workflowName, reason }, "Posted workflow refusal comment");
}
