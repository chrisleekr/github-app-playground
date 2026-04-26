import type pino from "pino";

import { createExecution } from "../orchestrator/history";
import type { SerializableBotContext } from "../shared/daemon-types";
import type { TriggerEventType } from "../shared/dispatch-types";
import type { DispatchTarget } from "./dispatcher";

/**
 * Builds the `context_json` shape the accept handler on
 * `src/orchestrator/connection-handler.ts` reads when a daemon claims a
 * workflow-dispatched job. Mirrors the fields `buildSyntheticBotContext`
 * (in handlers/plan.ts) fills and `serializeBotContext` emits — the only
 * keys consumed downstream on the workflow branch are `owner`, `repo`,
 * `isPR`, `labels`, plus the four fields `validateJobContext` hard-requires
 * (`deliveryId`, `owner`, `repo`, `entityNumber`). All other fields are
 * carried for forward-compat parity with the legacy pipeline shape.
 *
 * `eventName` defaults to `"issue_comment"` for label-triggered runs (no
 * originating comment) and is set to the real event when the dispatcher
 * was called from a comment webhook — that drives which Octokit reactions
 * endpoint is used downstream.
 */
export function buildWorkflowContextJson(params: {
  target: DispatchTarget;
  senderLogin: string;
  deliveryId: string;
  labels?: readonly string[];
  triggerCommentId?: number;
  triggerEventType?: TriggerEventType;
}): SerializableBotContext {
  const { target, senderLogin, deliveryId, labels, triggerCommentId, triggerEventType } = params;
  return {
    owner: target.owner,
    repo: target.repo,
    entityNumber: target.number,
    isPR: target.type === "pr",
    eventName: triggerEventType ?? "issue_comment",
    triggerUsername: senderLogin,
    triggerTimestamp: new Date().toISOString(),
    triggerBody: "",
    commentId: triggerCommentId ?? 0,
    deliveryId,
    labels: labels !== undefined ? [...labels] : [],
    defaultBranch: "",
    skipTrackingComments: true,
  };
}

/**
 * Persist an `executions` row and take a concurrency slot for a
 * workflow-dispatched job. MUST be called before `enqueueJob` so the
 * daemon's accept handler can resolve context_json via the delivery_id.
 * On failure, the caller must release the slot + unwind the workflow_runs
 * row — see `dispatcher.ts` / `orchestrator.ts` for the compensation
 * pattern.
 */
export async function recordWorkflowExecution(params: {
  deliveryId: string;
  target: DispatchTarget;
  senderLogin: string;
  workflowName: string;
  runId: string;
  labels?: readonly string[];
  logger: pino.Logger;
  triggerCommentId?: number;
  triggerEventType?: TriggerEventType;
}): Promise<void> {
  const { deliveryId, target, senderLogin, workflowName, runId, labels, logger } = params;
  const { triggerCommentId, triggerEventType } = params;

  const contextJson = buildWorkflowContextJson({
    target,
    senderLogin,
    deliveryId,
    ...(labels !== undefined ? { labels } : {}),
    ...(triggerCommentId !== undefined ? { triggerCommentId } : {}),
    ...(triggerEventType !== undefined ? { triggerEventType } : {}),
  });

  await createExecution({
    deliveryId,
    repoOwner: target.owner,
    repoName: target.repo,
    entityNumber: target.number,
    entityType: target.type === "pr" ? "pull_request" : "issue",
    eventName: triggerEventType ?? "issue_comment",
    triggerUsername: senderLogin,
    dispatchMode: "daemon",
    dispatchReason: "persistent-daemon",
    contextJson,
    ...(triggerCommentId !== undefined ? { triggerCommentId } : {}),
    ...(triggerEventType !== undefined ? { triggerEventType } : {}),
  });

  logger.info(
    {
      deliveryId,
      runId,
      workflowName,
      target,
      reason: "workflow-execution-row-written",
    },
    "Wrote executions row for workflow-dispatched job",
  );
}
