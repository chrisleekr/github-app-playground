import { Octokit } from "octokit";

import { logger } from "../logger";
import type { SerializableBotContext } from "../shared/daemon-types";
import { createMessageEnvelope, type JobPayloadMessage } from "../shared/ws-messages";
import { type CompletionResult,onStepComplete } from "../workflows/orchestrator";
import { getByName, type WorkflowRunContext } from "../workflows/registry";
import { markFailed, markRunning, markSucceeded, mergeState } from "../workflows/runs-store";
import { setState } from "../workflows/tracking-mirror";

/**
 * Daemon-side entry point for jobs carrying a `workflowRun` field. Implements
 * T019 (job-type router) from `specs/20260421-181205-bot-workflows`:
 *
 *   1. Resolve registry entry by `workflowRun.workflowName`.
 *   2. Build `WorkflowRunContext` (logger + octokit + deliveryId + setState).
 *   3. `runs-store.markRunning(runId)`.
 *   4. Invoke handler.
 *   5. Translate `HandlerResult` → `markSucceeded` | `markFailed` plus a final
 *      `tracking-mirror.setState` write.
 *   6. On uncaught throw → `markFailed({ reason: "uncaught: <message>" })`.
 *   7. Send `job:result` back to orchestrator.
 *
 * Structured log bindings (T024): every log line emitted from `log` carries
 * `{ workflowRunId, workflowName, target, deliveryId, offerId }`.
 */
export async function executeWorkflowRun(
  payload: JobPayloadMessage,
  send: (msg: unknown) => void,
): Promise<void> {
  const offerId = payload.id;
  const startedAt = Date.now();
  const workflowRun = payload.payload.workflowRun;
  const context = payload.payload.context as unknown as SerializableBotContext;
  const installationToken = payload.payload.installationToken;

  if (workflowRun === undefined) {
    // Defensive — `executeJob` already branches on this; if we get here the
    // caller routed an ordinary pipeline job to the wrong executor.
    logger.error({ offerId }, "executeWorkflowRun called without workflowRun — misrouted payload");
    return;
  }

  const target = {
    type: context.isPR ? ("pr" as const) : ("issue" as const),
    owner: context.owner,
    repo: context.repo,
    number: context.entityNumber,
  };

  const log = logger.child({
    offerId,
    workflowRunId: workflowRun.runId,
    workflowName: workflowRun.workflowName,
    deliveryId: context.deliveryId,
    target,
  });

  const octokit = new Octokit({ auth: installationToken });

  try {
    const entry = getByName(workflowRun.workflowName);
    await markRunning(workflowRun.runId);

    const runCtx: WorkflowRunContext = {
      runId: workflowRun.runId,
      workflowName: workflowRun.workflowName,
      target,
      ...(workflowRun.parentRunId !== undefined && workflowRun.parentStepIndex !== undefined
        ? { parent: { runId: workflowRun.parentRunId, stepIndex: workflowRun.parentStepIndex } }
        : {}),
      logger: log,
      octokit,
      deliveryId: context.deliveryId,
      setState: async (state, humanMessage) => {
        const patch =
          typeof state === "object" && state !== null
            ? (state as Record<string, unknown>)
            : { state };
        await setState({ octokit, logger: log }, { runId: workflowRun.runId, patch, humanMessage });
      },
    };

    const result = await entry.handler(runCtx);

    if (result.status === "handed-off") {
      // Composite parent: merge state, emit tracking comment, but leave
      // `status = running`. The orchestrator cascade will flip this row's
      // status once the final descendant completes. No `onStepComplete`
      // call here — this run has no terminal result to propagate yet.
      const handOffState =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await mergeState(workflowRun.runId, handOffState);
      await setState(
        { octokit, logger: log },
        {
          runId: workflowRun.runId,
          patch: {},
          humanMessage:
            result.humanMessage ?? `${entry.name} handed off to child ${result.childRunId}`,
        },
      );

      log.info(
        {
          durationMs: Date.now() - startedAt,
          outcome: "handed-off",
          childRunId: result.childRunId,
        },
        "Workflow run handed off to child",
      );

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: true,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
        },
      });
      return;
    }

    let completion: CompletionResult;

    if (result.status === "succeeded") {
      const state =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await markSucceeded(workflowRun.runId, state);
      await setState(
        { octokit, logger: log },
        {
          runId: workflowRun.runId,
          patch: {},
          humanMessage: result.humanMessage ?? `${entry.name} succeeded`,
        },
      );

      log.info(
        { durationMs: Date.now() - startedAt, outcome: "succeeded" },
        "Workflow run completed",
      );

      completion = { status: "succeeded" };

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: true,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
        },
      });
    } else {
      // Handler returned `failed`.
      const failState =
        typeof result.state === "object" && result.state !== null
          ? (result.state as Record<string, unknown>)
          : {};
      await markFailed(workflowRun.runId, result.reason, failState);
      await setState(
        { octokit, logger: log },
        {
          runId: workflowRun.runId,
          patch: {},
          humanMessage: result.humanMessage ?? `${entry.name} failed: ${result.reason}`,
        },
      );

      log.warn(
        { durationMs: Date.now() - startedAt, outcome: "failed", reason: result.reason },
        "Workflow run reported failure",
      );

      completion = { status: "failed", reason: result.reason };

      send({
        type: "job:result",
        ...createMessageEnvelope(offerId),
        payload: {
          success: false,
          deliveryId: context.deliveryId,
          durationMs: Date.now() - startedAt,
          errorMessage: result.reason,
        },
      });
    }

    // T030: propagate the terminal result up the composite chain. Wrapped
    // so a cascade error never masks the original handler outcome — the
    // daemon has already ack'd the job above.
    try {
      await onStepComplete({ octokit, logger: log }, workflowRun.runId, completion);
    } catch (cascadeErr) {
      log.error({ err: cascadeErr }, "onStepComplete cascade failed");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `uncaught: ${message}`;

    try {
      await markFailed(workflowRun.runId, reason, {});
      await setState(
        { octokit, logger: log },
        {
          runId: workflowRun.runId,
          patch: {},
          humanMessage: `${workflowRun.workflowName} failed: ${reason}`,
        },
      );
    } catch (cleanupErr) {
      log.error(
        { err: cleanupErr },
        "Failed to persist failure state after uncaught handler throw",
      );
    }

    log.error(
      { err, durationMs: Date.now() - startedAt, outcome: "uncaught" },
      "Workflow handler threw",
    );

    try {
      await onStepComplete({ octokit, logger: log }, workflowRun.runId, {
        status: "failed",
        reason,
      });
    } catch (cascadeErr) {
      log.error({ err: cascadeErr }, "onStepComplete cascade failed after uncaught");
    }

    send({
      type: "job:result",
      ...createMessageEnvelope(offerId),
      payload: {
        success: false,
        deliveryId: context.deliveryId,
        durationMs: Date.now() - startedAt,
        errorMessage: reason,
      },
    });
  }
}
