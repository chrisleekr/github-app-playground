/**
 * Ship-iteration handler (US1, T012). Bridges a non-ready probe verdict
 * onto the existing daemon `workflow_runs` pipeline so a single iteration
 * does exactly one of:
 *
 *   - terminate the intent on cap or deadline,
 *   - leave the intent active because the verdict is already ready
 *     (the caller's terminal-shortcut is responsible for the GraphQL mutation),
 *   - or insert a `workflow_runs` row + enqueue a daemon job + append a
 *     `ship_iterations` row so the orchestrator's completion cascade can
 *     early-wake the intent for the next iteration.
 *
 * One job per iteration (research.md Q4): the loop runs many iterations
 * rather than packing actions, because each daemon job mutates PR state
 * and the next probe is the only way to detect that a fix worked.
 *
 * The handler stays inside the `workflow_runs` tree (no new JobKind);
 * `state.shipIntentId` is the single signal that the orchestrator's
 * cascade uses to early-wake the intent on completion.
 */

import type { RedisClient, SQL } from "bun";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { appendIteration, type ShipIntentRow } from "../../db/queries/ship";
import { logger as rootLogger } from "../../logger";
import { enqueueJob } from "../../orchestrator/job-queue";
import type { BlockerCategory } from "../../shared/ship-types";
import type { WorkflowName } from "../registry";
import { insertQueued } from "../runs-store";
import { transitionToTerminal } from "./intent";
import { SHIP_LOG_EVENTS } from "./log-fields";
import type { MergeReadiness, NonReadinessReason } from "./verdict";

export interface RunIterationDeps {
  readonly sql?: SQL;
  readonly valkey?: Pick<RedisClient, "send">;
  readonly log?: Logger;
}

export interface RunIterationInput extends RunIterationDeps {
  readonly intent: ShipIntentRow;
  readonly probeVerdict: MergeReadiness;
}

export type RunIterationOutcome =
  | { readonly outcome: "enqueued"; readonly runId: string; readonly workflowName: WorkflowName }
  | { readonly outcome: "terminal-cap" }
  | { readonly outcome: "terminal-deadline" }
  | { readonly outcome: "ready-shortcut" };

/**
 * Drive one iteration. Pure-ish — no GitHub API calls; only Postgres +
 * Valkey writes via injected dependencies. Returns the outcome so the
 * caller can decide whether to short-circuit (e.g., on `ready-shortcut`).
 *
 * @throws when `probeVerdict` is non-ready but lacks a `reason` field
 *         (defensive — the verdict shape guarantees this, but we surface
 *         a clear error if a regression slips a malformed verdict in).
 */
export async function runIteration(input: RunIterationInput): Promise<RunIterationOutcome> {
  const sql = input.sql ?? requireDb();
  const log = (input.log ?? rootLogger).child({
    component: "ship.iteration",
    intent_id: input.intent.id,
    owner: input.intent.owner,
    repo: input.intent.repo,
    pr_number: input.intent.pr_number,
  });

  const intent = input.intent;

  // 1. Cap check (FR-013, SC-005). Counted on the action-row count alone
  //    (probe rows that have not produced an action don't consume the
  //    budget). The action we are about to enqueue would push the count
  //    over the configured cap if it equals or exceeds it.
  const completedActions = await countActionIterations(intent.id, sql);
  if (completedActions >= config.maxShipIterations) {
    await transitionToTerminal(intent.id, "deadline_exceeded", "iteration-cap", sql);
    log.info(
      {
        event: SHIP_LOG_EVENTS.iteration.terminalCap,
        cap: config.maxShipIterations,
        completed_actions: completedActions,
      },
      "ship iteration cap reached — intent terminated",
    );
    return { outcome: "terminal-cap" };
  }

  // 2. Deadline check.
  if (intent.deadline_at.getTime() <= Date.now()) {
    await transitionToTerminal(intent.id, "deadline_exceeded", null, sql);
    log.info(
      {
        event: SHIP_LOG_EVENTS.iteration.terminalDeadline,
        deadline_at: intent.deadline_at.toISOString(),
      },
      "ship deadline exceeded — intent terminated",
    );
    return { outcome: "terminal-deadline" };
  }

  // 3. Ready verdicts are handled by the caller's terminal-shortcut. We
  //    return without writing iteration state so the caller can do the
  //    `markPullRequestReadyForReview` GraphQL mutation atomically.
  if (input.probeVerdict.ready) {
    return { outcome: "ready-shortcut" };
  }

  const verdict = input.probeVerdict;
  if (typeof verdict.reason !== "string") {
    throw new Error("runIteration: probeVerdict missing reason field");
  }

  // 4. Persist the probe verdict as `kind=probe` (verdict columns allowed),
  //    then derive the iteration_n for the action row. Schema's
  //    `ship_iterations_verdict_only_on_probe_check` CHECK forbids verdict
  //    fields on action rows, so they live here.
  const totalRows = await countIterations(intent.id, sql);
  const probeIterationN = totalRows + 1;
  await appendIteration(
    {
      intent_id: intent.id,
      iteration_n: probeIterationN,
      kind: "probe",
      verdict_json: verdict,
      non_readiness_reason: verdict.reason,
    },
    sql,
  );

  // 5. Map verdict → next workflow_runs.workflow_name. Each non-readiness
  //    reason picks exactly one downstream workflow (research.md Q4).
  const nextWorkflowName = selectNextWorkflow(verdict.reason);
  const actionIterationN = probeIterationN + 1;

  // 6. Insert a `workflow_runs` row with `state.shipIntentId` so the
  //    orchestrator's `onStepComplete` cascade ZADDs `ship:tickle` on
  //    completion (T007). The deliveryId is synthesized from the intent
  //    id + iteration number so reaper queries can correlate the row
  //    back to the originating ship session.
  const run = await insertQueued(
    {
      workflowName: nextWorkflowName,
      target: { type: "pr", owner: intent.owner, repo: intent.repo, number: intent.pr_number },
      ownerKind: "orchestrator",
      ownerId: `ship-intent:${intent.id}`,
      initialState: { shipIntentId: intent.id, iteration_n: actionIterationN },
    },
    sql,
  );

  // 7. Enqueue the daemon job (workflow-run kind, carrying WorkflowRunRef).
  const childDeliveryId = `${intent.id}::iteration::${String(actionIterationN)}`;
  await enqueueJob({
    kind: "workflow-run",
    deliveryId: childDeliveryId,
    repoOwner: intent.owner,
    repoName: intent.repo,
    entityNumber: intent.pr_number,
    isPR: true,
    eventName: "pull_request",
    triggerUsername: "chrisleekr-bot[bot]",
    labels: [],
    triggerBodyPreview: "",
    enqueuedAt: Date.now(),
    retryCount: 0,
    workflowRun: { runId: run.id, workflowName: nextWorkflowName },
  });

  // 8. Append the action ship_iterations row. `kind=resolve` for fix-shaped
  //    runs; `kind=review` when the next workflow is `review`. Verdict
  //    columns are forbidden on non-`probe` kinds (schema CHECK).
  const iterationKind = nextWorkflowName === "review" ? "review" : "resolve";
  await appendIteration(
    {
      intent_id: intent.id,
      iteration_n: actionIterationN,
      kind: iterationKind,
      runs_store_id: run.id,
    },
    sql,
  );

  log.info(
    {
      event: SHIP_LOG_EVENTS.iteration.enqueued,
      iteration_n: actionIterationN,
      next_workflow: nextWorkflowName,
      run_id: run.id,
      verdict_reason: verdict.reason,
    },
    "ship iteration enqueued",
  );

  return { outcome: "enqueued", runId: run.id, workflowName: nextWorkflowName };
}

/**
 * Count action-flavored `ship_iterations` rows (kind ∈ {resolve, review,
 * branch-refresh}) for an intent. Probe rows do not consume the iteration
 * budget — only actions that mutate PR state do.
 */
async function countActionIterations(intentId: string, sql: SQL): Promise<number> {
  const rows: { count: number | string }[] = await sql`
    SELECT COUNT(*)::int AS count
      FROM ship_iterations
     WHERE intent_id = ${intentId}
       AND kind IN ('resolve', 'review', 'branch-refresh')
  `;
  const raw = rows[0]?.count;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  return 0;
}

/**
 * Choose the downstream `workflow_name` to dispatch for a given non-readiness
 * reason. One reason → one workflow (research.md Q4 single-action rule);
 * the loop runs many iterations rather than packing actions per iteration.
 */
function selectNextWorkflow(reason: NonReadinessReason): WorkflowName {
  switch (reason) {
    case "open_threads":
    case "changes_requested":
    case "failing_checks":
      return "resolve";
    case "behind_base":
      return "implement";
    case "pending_checks":
    case "mergeable_pending":
    case "review_barrier_deferred":
      return "review";
    case "human_took_over":
      // The caller normally short-circuits to terminal `human_took_over`;
      // if we land here defensively, fall back to a review-only run that
      // the orchestrator cascade cannot cause harm with.
      return "review";
  }
}

/**
 * Count completed `ship_iterations` rows for an intent. Used to compute the
 * next `iteration_n` and to enforce `config.maxShipIterations`.
 *
 * Used internally by `runIteration`; exported for tests + debugging.
 */
export async function countIterations(intentId: string, sql: SQL = requireDb()): Promise<number> {
  const rows: { count: number | string }[] = await sql`
    SELECT COUNT(*)::int AS count FROM ship_iterations WHERE intent_id = ${intentId}
  `;
  const raw = rows[0]?.count;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  return 0;
}

/**
 * Map a non-readiness verdict to the matching `BlockerCategory` for terminal
 * transitions. Currently unused by `runIteration` (cap and deadline have
 * fixed mappings), but exported so future failure paths can compute the
 * blocker category from a verdict without re-deriving it locally.
 */
export function blockerForVerdict(reason: NonReadinessReason): BlockerCategory {
  switch (reason) {
    case "human_took_over":
      return "manual-push-detected";
    case "behind_base":
      return "merge-conflict-needs-human";
    default:
      return "unrecoverable-error";
  }
}
