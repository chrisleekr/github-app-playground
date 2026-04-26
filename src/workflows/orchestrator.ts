import type { SQL } from "bun";
import type { Octokit } from "octokit";
import type pino from "pino";

import { config } from "../config";
import { requireDb } from "../db";
import { getInstanceId } from "../orchestrator/instance-id";
import { enqueueJob } from "../orchestrator/job-queue";
import { addReaction, type ReactionContent } from "../utils/reactions";
import { recordWorkflowExecution } from "./execution-row";
import { getByName, type WorkflowName } from "./registry";
import { findById, markFailed, type WorkflowRunRow } from "./runs-store";
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

    // ── Bespoke ship review/resolve loop ──────────────────────────────────
    // Localised here intentionally — generalising the registry to express
    // "loop back to step N when condition X holds" would add surface area
    // for one use case. If a second composite ever needs looping, extract.
    //
    // Semantics (cap = config.reviewResolveMaxIterations, default 2):
    //   - Each completed `review` child increments parent.state.review_iterations
    //     and records its findings count on parent.state.last_review_findings.
    //   - After review-N: if N ≥ 2 AND findings == 0 → parent succeeds early
    //     (skip resolve; nothing left to fix).
    //   - After resolve-N: if N < cap → insert another review (loop back to
    //     ship.steps.indexOf("review")). Else → parent succeeds; if
    //     last_review_findings > 0 the terminal message recommends manual
    //     re-review (we did not get to confirm resolve-N's fixes).
    const isShipParent = parent.workflow_name === "ship";
    const isReviewChild = child.workflow_name === "review";
    const isResolveChild = child.workflow_name === "resolve";

    let reviewIterations = extractReviewIterations(parent.state);
    let lastReviewFindings = extractLastReviewFindings(parent.state);
    if (isShipParent && isReviewChild) {
      reviewIterations += 1;
      lastReviewFindings = extractFindings(child.state, logger, child.id);
    }
    const reviewLoopState: Record<string, number> =
      isShipParent && (isReviewChild || isResolveChild)
        ? { review_iterations: reviewIterations, last_review_findings: lastReviewFindings }
        : {};

    const cap = config.reviewResolveMaxIterations;
    // The early-exit floor is `min(2, cap)` so a `cap === 1` deployment
    // — which means "never loop" — still terminates on its single review.
    // For `cap >= 2` this stays at 2, preserving the "at least two
    // independent passes" guarantee the user originally asked for.
    const reviewClean =
      isShipParent &&
      isReviewChild &&
      reviewIterations >= Math.min(2, cap) &&
      lastReviewFindings === 0;
    const shouldLoopBackToReview = isShipParent && isResolveChild && reviewIterations < cap;

    if (reviewClean || (nextIndex >= steps.length && !shouldLoopBackToReview)) {
      const successPatch = {
        currentStepIndex: nextIndex,
        stepRuns,
        ...reviewLoopState,
      };
      await tx`
        UPDATE workflow_runs
           SET status = 'succeeded',
               state = state || ${successPatch}::jsonb
         WHERE id = ${parent.id}
      `;
      let humanMessage = `ship complete — all ${String(steps.length)} steps succeeded.`;
      if (reviewClean) {
        humanMessage = `ship complete — review found no issues after ${String(reviewIterations)} iterations.`;
      } else if (isShipParent && reviewIterations >= cap && lastReviewFindings > 0) {
        humanMessage = `ship complete — review-${String(reviewIterations)} flagged ${String(lastReviewFindings)} issue${
          lastReviewFindings === 1 ? "" : "s"
        }; resolve-${String(reviewIterations)} attempted fixes. Manual re-review recommended.`;
      }
      postCommit = {
        enqueue: null,
        parentRunId: parent.id,
        parentTerminal: { status: "succeeded", humanMessage },
      };
      return;
    }

    // Determine the next step. Loop-back overrides the natural advance so
    // resolve-N → review-(N+1) instead of falling off the end of `steps`.
    const nextStepIndex = shouldLoopBackToReview ? steps.indexOf("review") : nextIndex;
    const nextStepName = steps[nextStepIndex];
    if (nextStepName === undefined) {
      throw new Error(`orchestrator: step index ${String(nextStepIndex)} out of bounds`);
    }

    // Phase 1 retargeting: when the next step's registry context is "pr"
    // but the parent's target is an issue (e.g., ship → review/resolve),
    // discover the PR number from the just-completed child's state (typical
    // hand-off from `implement`) or the parent's state (preserved across
    // loop-back iterations).
    const targetResult = deriveChildTarget(parent, child, nextStepName);
    if ("error" in targetResult) {
      const failPatch = {
        failedAtStepIndex: nextStepIndex,
        failedReason: targetResult.error,
        ...reviewLoopState,
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
          humanMessage: `ship halted at step ${String(nextStepIndex)} (${parent.workflow_name} → ${nextStepName}): ${targetResult.error}`,
        },
      };
      return;
    }
    const childTarget = targetResult;

    const inserted: WorkflowRunRow[] = await tx`
      INSERT INTO workflow_runs (
        workflow_name, target_type, target_owner, target_repo, target_number,
        parent_run_id, parent_step_index, status, state, delivery_id,
        owner_kind, owner_id
      ) VALUES (
        ${nextStepName}, ${childTarget.type}, ${childTarget.owner},
        ${childTarget.repo}, ${childTarget.number},
        ${parent.id}, ${nextStepIndex}, 'queued', '{}'::jsonb, ${parent.delivery_id},
        'orchestrator', ${getInstanceId()}
      )
      RETURNING *
    `;
    const nextChild = inserted[0];
    if (nextChild === undefined) {
      throw new Error("orchestrator: failed to insert next child row");
    }

    const progressPatch: Record<string, unknown> = {
      currentStepIndex: nextStepIndex,
      stepRuns,
      ...reviewLoopState,
    };
    // Persist pr_number on parent state on first retarget so subsequent
    // loop-back inserts can rediscover it without re-reading a child row.
    if (childTarget.type === "pr" && parent.target_type === "issue") {
      progressPatch["pr_number"] = childTarget.number;
    }
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
        parentStepIndex: nextStepIndex,
        deliveryId: parent.delivery_id,
        target: childTarget,
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
    const parentRunId = postCommit.parentRunId;
    const terminal = postCommit.parentTerminal;
    await setState(deps, {
      runId: parentRunId,
      patch: {},
      humanMessage: terminal.humanMessage,
    }).catch((err: unknown) => {
      logger.warn({ err, parentId: parentRunId }, "parent tracking emit failed");
    });

    // Composite parents (e.g., ship) terminate here, not in the daemon
    // executor — so this is the right point to react on the user's trigger
    // comment with the chain's final outcome.
    await reactOnParentTrigger(
      deps,
      parentRunId,
      terminal.status === "succeeded" ? "hooray" : "confused",
    );
  }
}

async function reactOnParentTrigger(
  deps: OnStepCompleteDeps,
  parentRunId: string,
  content: ReactionContent,
): Promise<void> {
  try {
    const row = await findById(parentRunId);
    if (row === null) return;
    if (row.trigger_comment_id === null || row.trigger_event_type === null) return;
    await addReaction({
      octokit: deps.octokit,
      logger: deps.logger,
      owner: row.target_owner,
      repo: row.target_repo,
      commentId: row.trigger_comment_id,
      eventType: row.trigger_event_type,
      content,
    });
  } catch (err) {
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err), parentRunId, content },
      "reactOnParentTrigger failed",
    );
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

function extractPrNumber(state: Record<string, unknown>): number | null {
  const raw = state["pr_number"];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * Reads `state.findings.total` written by the `review` handler. A missing
 * or malformed value is treated as "non-clean" via `Number.MAX_SAFE_INTEGER`
 * so a regressed review handler that forgets to populate findings cannot
 * accidentally short-circuit the loop into an early ship-succeed (which is
 * the silent-bail class this PR is otherwise tightening). The warning
 * surfaces the regression in operator logs instead of swallowing it.
 */
function extractFindings(
  state: Record<string, unknown>,
  logger: pino.Logger,
  childRunId: string,
): number {
  const raw = state["findings"];
  if (raw !== null && typeof raw === "object") {
    const total = (raw as Record<string, unknown>)["total"];
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  }
  logger.warn(
    { childRunId, findings: raw },
    "orchestrator: review child has no usable findings.total — refusing to short-circuit ship loop",
  );
  return Number.MAX_SAFE_INTEGER;
}

function extractReviewIterations(state: Record<string, unknown>): number {
  const raw = state["review_iterations"];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

function extractLastReviewFindings(state: Record<string, unknown>): number {
  const raw = state["last_review_findings"];
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

interface ChildTarget {
  type: "issue" | "pr";
  owner: string;
  repo: string;
  number: number;
}

function deriveChildTarget(
  parent: WorkflowRunRow,
  child: WorkflowRunRow,
  nextStepName: WorkflowName,
): ChildTarget | { error: string } {
  const nextEntry = getByName(nextStepName);
  if (nextEntry.context !== "pr" || parent.target_type === "pr") {
    return {
      type: parent.target_type,
      owner: parent.target_owner,
      repo: parent.target_repo,
      number: parent.target_number,
    };
  }
  const prNumber = extractPrNumber(child.state) ?? extractPrNumber(parent.state);
  if (prNumber === null) {
    return {
      error: `${nextStepName} requires PR target but no pr_number found in child or parent state`,
    };
  }
  return {
    type: "pr",
    owner: parent.target_owner,
    repo: parent.target_repo,
    number: prNumber,
  };
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
