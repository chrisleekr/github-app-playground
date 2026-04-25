import { requireDb } from "../../db";
import { enqueueJob } from "../../orchestrator/job-queue";
import { recordWorkflowExecution } from "../execution-row";
import {
  getByName,
  type WorkflowHandler,
  type WorkflowName,
  type WorkflowRunContext,
} from "../registry";
import { findLatestForTarget, type WorkflowRunRow } from "../runs-store";

/**
 * `ship` composite handler (T031) — the entry point for the end-to-end
 * triage → plan → implement → review pipeline.
 *
 * Resume semantics (T033 / FR-013 / FR-020):
 *   - `bot:ship` is re-applicable on a target that has a prior **terminal**
 *     parent row (succeeded or failed). The partial unique index on
 *     `workflow_runs` only blocks in-flight rows, so a new parent insert
 *     succeeds.
 *   - The handler walks `registry.ship.steps` left-to-right and, for each
 *     step, asks: does a fresh output exist for this target? Staleness
 *     rules per `contracts/handoff-protocol.md`:
 *       triage    — fresh iff succeeded row exists AND `state.recommendedNext==='plan'`
 *       plan      — fresh iff succeeded row exists AND created AFTER the last triage success
 *       implement — fresh iff succeeded row exists AND recorded PR is still open
 *       review    — always stale
 *   - The first stale step becomes `startIndex`. Prior-step run ids are
 *     carried forward in `state.stepRuns` so the tracking comment can link
 *     them.
 *
 * Return value is `handed-off` — the executor merges state but keeps the
 * parent row in `running` until the final child succeeds or any child
 * fails. The orchestrator's cascade (in `src/workflows/orchestrator.ts`)
 * handles the terminal transition.
 */
export const handler: WorkflowHandler = async (ctx) => {
  const { target, logger: log, runId: parentRunId, deliveryId, daemonId } = ctx;

  try {
    if (target.type !== "issue") {
      return { status: "failed", reason: "ship requires issue target" };
    }

    const steps = getByName("ship").steps;

    const { startIndex, priorRunIds } = await computeStartIndex({
      steps,
      target,
      octokit: ctx.octokit,
      logger: log,
    });

    const firstStep = steps[startIndex];
    if (firstStep === undefined) {
      // All steps fresh → nothing to do; mark handed-off with no child so
      // the orchestrator flips the parent immediately. We do that by
      // inserting a synthetic completion path: cascade to succeeded.
      // Simplest path: fall through to insert a child for the last step
      // anyway — but review is always stale, so this branch is unreachable
      // in practice. Defensive failure.
      return { status: "failed", reason: "ship: computed startIndex out of range" };
    }

    const child = await insertChildRow({
      parentRunId,
      parentStepIndex: startIndex,
      workflowName: firstStep,
      target,
      deliveryId: deliveryId ?? null,
      daemonId,
    });

    // First child step uses its own runId as deliveryId so the `executions`
    // row doesn't collide with the parent's webhook-scoped deliveryId.
    const childDeliveryId = child.id;
    await recordWorkflowExecution({
      deliveryId: childDeliveryId,
      target,
      senderLogin: "chrisleekr-bot[bot]",
      workflowName: firstStep,
      runId: child.id,
      logger: log,
    });
    await enqueueJob({
      deliveryId: childDeliveryId,
      repoOwner: target.owner,
      repoName: target.repo,
      entityNumber: target.number,
      isPR: false,
      eventName: "issues",
      triggerUsername: "chrisleekr-bot[bot]",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
      workflowRun: {
        runId: child.id,
        workflowName: firstStep,
        parentRunId,
        parentStepIndex: startIndex,
      },
    });

    const state = {
      currentStepIndex: startIndex,
      stepRuns: priorRunIds,
      handedOffTo: child.id,
    };
    const humanMessage =
      startIndex === 0
        ? `ship started — first step \`${firstStep}\` queued.`
        : `ship resumed at step ${String(startIndex)} (\`${firstStep}\`); ${String(priorRunIds.length)} prior step(s) reused.`;

    await ctx.setState(state, humanMessage);

    log.info(
      { startIndex, firstStep, childRunId: child.id, priorRunIds },
      "ship handler handed off to first child",
    );

    return {
      status: "handed-off",
      state,
      humanMessage,
      childRunId: child.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, "ship handler caught error");
    return { status: "failed", reason: `ship failed: ${message}` };
  }
};

interface ComputeStartIndexParams {
  readonly steps: readonly WorkflowName[];
  readonly target: WorkflowRunContext["target"];
  readonly octokit: WorkflowRunContext["octokit"];
  readonly logger: WorkflowRunContext["logger"];
}

async function computeStartIndex(params: ComputeStartIndexParams): Promise<{
  startIndex: number;
  priorRunIds: string[];
}> {
  const { steps, target, octokit, logger } = params;
  const priorRunIds: string[] = [];
  const targetKey = { owner: target.owner, repo: target.repo, number: target.number };

  let triageCreatedAt: Date | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const latest = await findLatestForTarget(step, targetKey);

    // eslint-disable-next-line no-await-in-loop -- sequential by design
    const fresh = await isFresh({
      step,
      latest,
      triageCreatedAt,
      octokit,
      owner: target.owner,
      repo: target.repo,
      logger,
    });
    if (!fresh) {
      return { startIndex: i, priorRunIds };
    }

    if (latest !== null) {
      priorRunIds.push(latest.id);
      if (step === "triage") triageCreatedAt = latest.created_at;
    }
  }

  // All steps fresh — should be unreachable because `review` is always
  // stale. Return the last index so caller defensively inserts a review
  // child.
  return { startIndex: steps.length - 1, priorRunIds: priorRunIds.slice(0, -1) };
}

interface IsFreshParams {
  readonly step: WorkflowName;
  readonly latest: WorkflowRunRow | null;
  readonly triageCreatedAt: Date | null;
  readonly octokit: WorkflowRunContext["octokit"];
  readonly owner: string;
  readonly repo: string;
  readonly logger: WorkflowRunContext["logger"];
}

async function isFresh(params: IsFreshParams): Promise<boolean> {
  const { step, latest, triageCreatedAt, octokit, owner, repo, logger } = params;

  if (latest?.status !== "succeeded") return false;

  if (step === "review") return false;

  if (step === "triage") {
    return latest.state["recommendedNext"] === "plan";
  }

  if (step === "plan") {
    if (triageCreatedAt === null) return false;
    return new Date(latest.created_at).getTime() > new Date(triageCreatedAt).getTime();
  }

  if (step === "implement") {
    const prNumber = latest.state["pr_number"];
    if (typeof prNumber !== "number") return false;
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return pr.state === "open";
    } catch (err) {
      logger.warn(
        { err, prNumber, owner, repo },
        "ship: failed to verify PR state — treating implement as stale",
      );
      return false;
    }
  }

  return true;
}

interface InsertChildParams {
  readonly parentRunId: string;
  readonly parentStepIndex: number;
  readonly workflowName: WorkflowName;
  readonly target: WorkflowRunContext["target"];
  readonly deliveryId: string | null;
  readonly daemonId: string;
}

async function insertChildRow(params: InsertChildParams): Promise<WorkflowRunRow> {
  const sql = requireDb();
  const rows: WorkflowRunRow[] = await sql`
    INSERT INTO workflow_runs (
      workflow_name, target_type, target_owner, target_repo, target_number,
      parent_run_id, parent_step_index, status, state, delivery_id,
      owner_kind, owner_id
    ) VALUES (
      ${params.workflowName}, ${params.target.type}, ${params.target.owner},
      ${params.target.repo}, ${params.target.number},
      ${params.parentRunId}, ${params.parentStepIndex}, 'queued', '{}'::jsonb,
      ${params.deliveryId}, 'daemon', ${params.daemonId}
    )
    RETURNING *
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("insertChildRow: INSERT returned no row");
  return row;
}
