import type { Octokit } from "octokit";
import type pino from "pino";

import { config } from "../config";
import { enqueueJob } from "../orchestrator/job-queue";
import { classify, type ClassifyResult } from "./intent-classifier";
import { enforceSingleBotLabel } from "./label-mutex";
import { getByLabel, getByName, type WorkflowName } from "./registry";
import { findLatestForTarget, insertQueued } from "./runs-store";
import { postRefusalComment } from "./tracking-mirror";

export interface DispatchTarget {
  readonly type: "issue" | "pr";
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export interface DispatchByLabelParams {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly label: string;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
}

export type DispatchOutcome =
  | { readonly status: "dispatched"; readonly runId: string; readonly workflowName: WorkflowName }
  | { readonly status: "ignored"; readonly reason: string }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly workflowName: WorkflowName | "unknown";
    };

/**
 * Label-triggered workflow dispatch. Implements the seven-step protocol in
 * `specs/20260421-181205-bot-workflows/contracts/webhook-dispatch.md` §Label
 * trigger: registry lookup → context check → label mutex → prior-output
 * requirement → idempotency insert → job enqueue → return.
 *
 * ALLOWED_OWNERS enforcement is intentionally out of scope here — the
 * webhook event handler drops those events before calling the dispatcher
 * (no DB row, no queue job, no comment; see FR-015).
 */
export async function dispatchByLabel(params: DispatchByLabelParams): Promise<DispatchOutcome> {
  const { octokit, logger, label, target, senderLogin, deliveryId } = params;

  const entry = getByLabel(label);
  if (entry === undefined) {
    return { status: "ignored", reason: `no registry entry for label '${label}'` };
  }

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }

  await enforceSingleBotLabel({
    octokit,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    justApplied: label,
    logger,
  });

  if (entry.requiresPrior !== null) {
    const prior = await findLatestForTarget(entry.requiresPrior, target);
    if (prior?.status !== "succeeded") {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
  }

  try {
    const runRow = await insertQueued({
      workflowName: entry.name,
      target,
      deliveryId,
    });

    await enqueueJob({
      deliveryId,
      repoOwner: target.owner,
      repoName: target.repo,
      entityNumber: target.number,
      isPR: target.type === "pr",
      eventName: target.type === "pr" ? "pull_request" : "issues",
      triggerUsername: senderLogin,
      labels: [label],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
      workflowRun: { runId: runRow.id, workflowName: entry.name },
    });

    logger.info(
      {
        runId: runRow.id,
        workflowName: entry.name,
        target,
        deliveryId,
        senderLogin,
        reason: "workflow-dispatch",
      },
      "Workflow run dispatched",
    );

    return { status: "dispatched", runId: runRow.id, workflowName: entry.name };
  } catch (err) {
    // Partial unique index collision — an in-flight run already exists.
    logger.info(
      {
        workflowName: entry.name,
        target,
        deliveryId,
        err: err instanceof Error ? err.message : String(err),
        reason: "workflow-dispatch-inflight",
      },
      "Workflow dispatch refused — in-flight run already exists",
    );
    const reason = "an in-flight run already exists for this workflow and target";
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }
}

export interface DispatchByIntentParams {
  readonly octokit: Octokit;
  readonly logger: pino.Logger;
  readonly commentBody: string;
  readonly target: DispatchTarget;
  readonly senderLogin: string;
  readonly deliveryId: string;
}

/**
 * Comment-triggered dispatch. Runs the intent classifier against the
 * comment body, then reuses the label-dispatch pathway (context check,
 * label mutex, prior-output check, idempotent insert, enqueue) for the
 * chosen workflow.
 *
 *   - confidence < `INTENT_CONFIDENCE_THRESHOLD` (or `workflow === 'clarify'`)
 *     → post a short clarification comment (FR-009) and return `ignored`.
 *   - `workflow === 'unsupported'`                → post a refusal (FR-010).
 *   - otherwise                                   → dispatch the workflow.
 */
export async function dispatchByIntent(params: DispatchByIntentParams): Promise<DispatchOutcome> {
  const { octokit, logger, commentBody, target, senderLogin, deliveryId } = params;

  const verdict = await classify(commentBody);
  logger.info(
    {
      target,
      deliveryId,
      senderLogin,
      intentWorkflow: verdict.workflow,
      intentConfidence: verdict.confidence,
      reason: "intent-classified",
    },
    "Intent classification complete",
  );

  if (verdict.workflow === "unsupported") {
    await postRefusalComment(
      { octokit, logger },
      target,
      "unknown",
      `unsupported request — ${verdict.rationale}`,
    );
    return { status: "refused", workflowName: "unknown", reason: verdict.rationale };
  }

  if (verdict.workflow === "clarify" || verdict.confidence < config.intentConfidenceThreshold) {
    await postClarifyComment({ octokit, logger }, target, verdict);
    return {
      status: "ignored",
      reason: `classifier confidence ${String(verdict.confidence)} < threshold ${String(config.intentConfidenceThreshold)}`,
    };
  }

  const entry = getByName(verdict.workflow);

  const contextMatches =
    entry.context === "both" ||
    (entry.context === "issue" && target.type === "issue") ||
    (entry.context === "pr" && target.type === "pr");

  if (!contextMatches) {
    const reason = `workflow '${entry.name}' only accepts ${entry.context} targets (this is a ${target.type})`;
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }

  await enforceSingleBotLabel({
    octokit,
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    justApplied: entry.label,
    logger,
  });

  if (entry.requiresPrior !== null) {
    const prior = await findLatestForTarget(entry.requiresPrior, target);
    if (prior?.status !== "succeeded") {
      const reason = `requires a successful '${entry.requiresPrior}' run before '${entry.name}'`;
      await postRefusalComment({ octokit, logger }, target, entry.name, reason);
      return { status: "refused", workflowName: entry.name, reason };
    }
  }

  try {
    const runRow = await insertQueued({ workflowName: entry.name, target, deliveryId });

    await enqueueJob({
      deliveryId,
      repoOwner: target.owner,
      repoName: target.repo,
      entityNumber: target.number,
      isPR: target.type === "pr",
      eventName: target.type === "pr" ? "pull_request" : "issues",
      triggerUsername: senderLogin,
      labels: [entry.label],
      triggerBodyPreview: commentBody.slice(0, 120),
      enqueuedAt: Date.now(),
      retryCount: 0,
      workflowRun: { runId: runRow.id, workflowName: entry.name },
    });

    logger.info(
      {
        runId: runRow.id,
        workflowName: entry.name,
        target,
        deliveryId,
        senderLogin,
        reason: "workflow-dispatch-by-intent",
        intentConfidence: verdict.confidence,
      },
      "Workflow run dispatched via intent",
    );

    return { status: "dispatched", runId: runRow.id, workflowName: entry.name };
  } catch (err) {
    logger.info(
      {
        workflowName: entry.name,
        target,
        deliveryId,
        err: err instanceof Error ? err.message : String(err),
        reason: "workflow-dispatch-inflight",
      },
      "Workflow dispatch (intent) refused — in-flight run already exists",
    );
    const reason = "an in-flight run already exists for this workflow and target";
    await postRefusalComment({ octokit, logger }, target, entry.name, reason);
    return { status: "refused", workflowName: entry.name, reason };
  }
}

async function postClarifyComment(
  deps: { octokit: Octokit; logger: pino.Logger },
  target: DispatchTarget,
  verdict: ClassifyResult,
): Promise<void> {
  try {
    await deps.octokit.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
      body: [
        `**@chrisleekr-bot** — I'm not sure which workflow you'd like me to run (confidence \`${verdict.confidence.toFixed(2)}\`).`,
        ``,
        `Reply with one of the \`bot:*\` labels (e.g. \`bot:triage\`, \`bot:plan\`, \`bot:implement\`, \`bot:review\`, \`bot:ship\`) or rephrase so the ask is explicit.`,
        ``,
        `_Rationale_: ${verdict.rationale}`,
      ].join("\n"),
    });
  } catch (err) {
    deps.logger.warn({ err, target }, "postClarifyComment: createComment failed");
  }
}
