import type { SQL } from "bun";
import type { Octokit } from "octokit";
import type pino from "pino";

import { requireDb } from "../db";
import { getInstanceId } from "../orchestrator/instance-id";
import { enqueueJob } from "../orchestrator/job-queue";
import { recordWorkflowExecution } from "./execution-row";
import { getByName, type WorkflowName } from "./registry";
import { markFailed, type WorkflowRunRow } from "./runs-store";
import { setState } from "./tracking-mirror";

/**
 * Composite-workflow hand-off engine. Runs as the LAST step of every
 * workflow job (after the handler's terminal write) and cascades completion
 * up the parent chain per `contracts/handoff-protocol.md`.
 *
 * For non-composite runs (no `parent_run_id`) this is a no-op apart from
 * the tracking-comment emit that the executor already made.
 *
 * Transaction invariants:
 *   - `SELECT … FOR UPDATE` on the parent row eliminates the race where two
 *     concurrent children's completion writes could each insert their own
 *     "next" child.
 *   - Job enqueue for the newly-inserted next child happens AFTER COMMIT so
 *     the queue never observes a run id that doesn't exist in the DB.
 *   - On a child failure, no further children are inserted — the parent is
 *     flipped to `failed` with `failedAtStepIndex` and the cascade stops.
 */

export interface CompletionResult {
  readonly status: "succeeded" | "failed";
  readonly reason?: string;
}

export interface OnStepCompleteDeps {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
}

export async function onStepComplete(
  deps: OnStepCompleteDeps,
  childRunId: string,
  result: CompletionResult,
): Promise<void> {
  const db = requireDb();
  const { logger } = deps;

  // Capture anything the transaction wants to emit AFTER commit so the DB
  // is the source of truth for enqueued jobs and GitHub API calls. The
  // transaction body populates this; the post-commit block consumes it.
  let postCommit: PostCommitActions = { enqueue: null, parentRunId: null, parentTerminal: null };

  await db.begin(async (tx) => {
    const child = await loadChild(tx, childRunId);
    if (child === null) {
      logger.warn({ childRunId }, "onStepComplete: child run row not found");
      return;
    }

    if (child.parent_run_id === null) {
      return;
    }

    const parent = await lockParent(tx, child.parent_run_id);
    if (parent === null) {
      logger.warn({ childRunId, parentId: child.parent_run_id }, "onStepComplete: parent missing");
      return;
    }

    const steps = getByName(parent.workflow_name).steps;
    const childStepIndex = child.parent_step_index ?? -1;

    if (result.status === "failed") {
      const failPatch = {
        failedAtStepIndex: childStepIndex,
        failedReason: result.reason ?? "child failed",
      };
      await tx`
        UPDATE workflow_runs
           SET status = 'failed',
               state = state || ${failPatch}::jsonb
         WHERE id = ${parent.id}
      `;
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: {
          status: "failed",
          humanMessage: `ship halted at step ${String(childStepIndex)} (${parent.workflow_name} → ${child.workflow_name}): ${result.reason ?? "unknown"}`,
        },
      };
      return;
    }

    const nextIndex = childStepIndex + 1;
    const stepRuns = extractStepRuns(parent.state);
    stepRuns.push(childRunId);

    if (nextIndex >= steps.length) {
      const successPatch = { currentStepIndex: nextIndex, stepRuns };
      await tx`
        UPDATE workflow_runs
           SET status = 'succeeded',
               state = state || ${successPatch}::jsonb
         WHERE id = ${parent.id}
      `;
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: {
          status: "succeeded",
          humanMessage: `ship complete — all ${String(steps.length)} steps succeeded.`,
        },
      };
      return;
    }

    const nextStepName = steps[nextIndex];
    if (nextStepName === undefined) {
      throw new Error(`orchestrator: step index ${String(nextIndex)} out of bounds`);
    }

    const inserted: WorkflowRunRow[] = await tx`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state, delivery_id,
        owner_kind, owner_id
      ) VALUES (
        ${nextStepName}, ${parent.target_type}, ${parent.target_owner},
        ${parent.target_repo}, ${parent.target_number},
        ${parent.id}, ${nextIndex}, 'queued', '{}'::jsonb, ${parent.delivery_id},
        'orchestrator', ${getInstanceId()}
      )
      RETURNING *
    `;
    const nextChild = inserted[0];
    if (nextChild === undefined) {
      throw new Error("orchestrator: failed to insert next child row");
    }

    const progressPatch = { currentStepIndex: nextIndex, stepRuns };
    await tx`
      UPDATE workflow_runs
         SET state = state || ${progressPatch}::jsonb
       WHERE id = ${parent.id}
    `;

    postCommit = {
      enqueue: {
        runId: nextChild.id,
        workflowName: nextStepName,
        parentRunId: parent.id,
        parentStepIndex: nextIndex,
        deliveryId: parent.delivery_id,
        target: {
          type: parent.target_type,
          owner: parent.target_owner,
          repo: parent.target_repo,
          number: parent.target_number,
        },
      },
      parentRunId: parent.id,
      parentTerminal: null,
    };
  });

  if (postCommit.enqueue !== null) {
    const job = postCommit.enqueue;
    // Cascade steps use `runId` as deliveryId to avoid collision with the
    // parent's `executions.delivery_id` (UNIQUE NOT NULL). Parent's original
    // webhook deliveryId is retained on the workflow_runs row for traceability
    // but is NOT reused as the per-step executions key.
    const childDeliveryId = job.runId;
    try {
      await recordWorkflowExecution({
        deliveryId: childDeliveryId,
        target: job.target,
        senderLogin: "chrisleekr-bot[bot]",
        workflowName: job.workflowName,
        runId: job.runId,
        logger,
      });
      await enqueueJob({
        deliveryId: childDeliveryId,
        repoOwner: job.target.owner,
        repoName: job.target.repo,
        entityNumber: job.target.number,
        isPR: job.target.type === "pr",
        eventName: job.target.type === "pr" ? "pull_request" : "issues",
        triggerUsername: "chrisleekr-bot[bot]",
        labels: [],
        triggerBodyPreview: "",
        enqueuedAt: Date.now(),
        retryCount: 0,
        workflowRun: {
          runId: job.runId,
          workflowName: job.workflowName,
          parentRunId: job.parentRunId,
          parentStepIndex: job.parentStepIndex,
        },
      });
      logger.info(
        { nextRunId: job.runId, nextWorkflow: job.workflowName, parentId: job.parentRunId },
        "orchestrator enqueued next step",
      );
    } catch (err) {
      // Compensation: the transaction committed a `queued` child row and
      // mutated the parent's `state`, but Valkey was unreachable (or the
      // publish rejected the payload). Without this branch the child would
      // sit `queued` forever, and the partial unique index would block any
      // retry for the same (workflow, target). Mark both rows `failed`
      // BEFORE returning so the index releases and the operator gets a
      // breadcrumb on the tracking comment.
      const reason = `enqueue failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(
        { err, nextRunId: job.runId, parentId: job.parentRunId },
        "orchestrator post-commit enqueue failed — compensating by marking child and parent failed",
      );
      await markFailed(job.runId, reason).catch((markErr: unknown) => {
        logger.error(
          { err: markErr, nextRunId: job.runId },
          "compensation: failed to mark child row as failed",
        );
      });
      await markFailed(job.parentRunId, reason, {
        failedAtStepIndex: job.parentStepIndex,
      }).catch((markErr: unknown) => {
        logger.error(
          { err: markErr, parentId: job.parentRunId },
          "compensation: failed to mark parent row as failed",
        );
      });
      // Surface via the parent's tracking comment so the operator sees
      // the failure without needing to tail logs.
      postCommit = {
        ...postCommit,
        parentTerminal: {
          status: "failed",
          humanMessage: `ship halted at step ${String(job.parentStepIndex)} (${job.workflowName}): enqueue failed — see daemon logs for retry.`,
        },
      };
    }
  }

  if (postCommit.parentTerminal !== null && postCommit.parentRunId !== null) {
    await setState(deps, {
      runId: postCommit.parentRunId,
      patch: {},
      humanMessage: postCommit.parentTerminal.humanMessage,
    }).catch((err: unknown) => {
      logger.warn({ err, parentId: postCommit.parentRunId }, "parent tracking emit failed");
    });
  }
}

interface PostCommitActions {
  enqueue: {
    runId: string;
    workflowName: WorkflowName;
    parentRunId: string;
    parentStepIndex: number;
    deliveryId: string | null;
    target: { type: "issue" | "pr"; owner: string; repo: string; number: number };
  } | null;
  parentRunId: string | null;
  parentTerminal: { status: "succeeded" | "failed"; humanMessage: string } | null;
}

function extractStepRuns(state: Record<string, unknown>): string[] {
  const raw = state["stepRuns"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

async function loadChild(tx: SQL, childRunId: string): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await tx`
    SELECT * FROM workflow_runs WHERE id = ${childRunId}
  `;
  return rows[0] ?? null;
}

async function lockParent(tx: SQL, parentId: string): Promise<WorkflowRunRow | null> {
  const rows: WorkflowRunRow[] = await tx`
    SELECT * FROM workflow_runs WHERE id = ${parentId} FOR UPDATE
  `;
  return rows[0] ?? null;
}
