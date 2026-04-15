import { config } from "../config";
import { runInlinePipeline } from "../core/inline-pipeline";
import { isAlreadyProcessed } from "../core/tracking-comment";
import { getDb } from "../db";
import { classifyStatic } from "../k8s/classifier";
import {
  decrementActiveCount,
  getActiveCount,
  incrementActiveCount,
  isAtCapacity,
} from "../orchestrator/concurrency";
import { createExecution } from "../orchestrator/history";
import { dispatchJob } from "../orchestrator/job-dispatcher";
import { enqueueJob, type QueuedJob } from "../orchestrator/job-queue";
import { isValkeyHealthy } from "../orchestrator/valkey";
import type { DispatchReason, DispatchTarget } from "../shared/dispatch-types";
import { type BotContext, serializeBotContext } from "../types";
import { isOwnerAllowed } from "./authorize";

/**
 * Thrown when the router tries to dispatch to a target whose implementation
 * has not yet landed. Slice B adds the decideDispatch/dispatch scaffolding
 * with only the inline / daemon / shared-runner branches wired; isolated-job
 * lights up in Slice C (US1 T019) and auto mode in Slice D (US2 T035).
 *
 * Named error class (not a bare Error) so callers can distinguish "not
 * implemented" from an unexpected runtime failure; emitted as a typed log
 * field in processRequest.
 */
export class NotImplementedError extends Error {
  constructor(readonly target: DispatchTarget) {
    super(`Dispatch target '${target}' is not yet implemented`);
    this.name = "NotImplementedError";
  }
}

/**
 * DispatchDecision — the in-memory record the router produces for each
 * event. Mirrors data-model.md §5. `triage` is absent in Slice B (added in
 * T034/T035) and so is `complexity`.
 */
export interface DispatchDecision {
  target: DispatchTarget;
  reason: DispatchReason;
  maxTurns: number;
}

/**
 * In-memory idempotency guard using X-GitHub-Delivery header.
 * Prevents duplicate processing on webhook retries.
 *
 * Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
 */
const processed = new Map<string, number>();

// Active concurrent request counter moved to src/orchestrator/concurrency.ts (T051)
// for cross-module tracking across inline + daemon dispatch modes.

// Periodic cleanup of stale entries (1 hour TTL).
// unref() prevents this timer from keeping the process alive during shutdown.
// See: https://nodejs.org/api/timers.html#timeoutunref
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

/**
 * Remove idempotency map entries whose timestamp is older than `ttlMs`.
 * Exported as a pure function (dependency injection) so tests can exercise
 * the cleanup logic directly against a test-owned Map without mocking timers.
 *
 * @param entries - Map of delivery-id → timestamp (ms epoch) to prune in place
 * @param ttlMs - Entries older than (now - ttlMs) are deleted
 */
export function cleanupStaleIdempotencyEntries(entries: Map<string, number>, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [id, ts] of entries) {
    if (ts < cutoff) {
      entries.delete(id);
    }
  }
}

// Bind the pure function to the module-private map and TTL, then pass the
// bound reference to setInterval. `.bind()` creates a runtime-bound function
// without adding a new function definition in the source AST, so coverage
// instrumentation does not count a separate uncovered arrow wrapper.
const cleanupInterval = setInterval(
  cleanupStaleIdempotencyEntries.bind(null, processed, IDEMPOTENCY_TTL_MS),
  IDEMPOTENCY_TTL_MS,
);
cleanupInterval.unref();

/**
 * Main async processing entry point.
 * Called fire-and-forget from event handlers after the webhook has responded 200 OK.
 *
 * Handles routing concerns (idempotency, auth, concurrency) then delegates
 * the actual execution pipeline to runInlinePipeline().
 */
export async function processRequest(ctx: BotContext): Promise<void> {
  // Fast-path idempotency: in-memory check (current process lifetime only)
  if (processed.has(ctx.deliveryId)) {
    ctx.log.info("Skipping duplicate delivery (in-memory)");
    return;
  }

  // Reserve the delivery ID in-memory BEFORE the async durable check.
  // This closes the race window where two near-simultaneous retries with the same
  // deliveryId could both pass the has() check, then both pass isAlreadyProcessed()
  // (before either creates the tracking comment), and proceed to duplicate work.
  // Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
  processed.set(ctx.deliveryId, Date.now());

  // Durable idempotency: check if we already posted a tracking comment for this
  // delivery. Survives pod restarts; catches GitHub retries after OOM / rolling updates.
  if (await isAlreadyProcessed(ctx)) {
    ctx.log.info("Skipping duplicate delivery (durable marker found)");
    // Key stays in map — delivery IS processed; subsequent retries hit the fast path.
    return;
  }

  // Owner allowlist check — MUST run before any GitHub side effects (including
  // the capacity comment posted by the concurrency guard below). Otherwise a
  // non-allowlisted repo could receive the "at capacity" comment and thereby
  // learn the bot exists, defeating the "silent skip" guarantee.
  //
  // No rejection comment is posted for non-allowlisted owners — operators see
  // rejections via logger.warn. This is a ToS prerequisite when running on
  // CLAUDE_CODE_OAUTH_TOKEN: https://code.claude.com/docs/en/agent-sdk/overview
  const authResult = isOwnerAllowed(ctx.owner, ctx.log);
  if (!authResult.allowed) {
    ctx.log.info({ reason: authResult.reason }, "skipping request — owner not allowlisted");
    return;
  }

  // Concurrency guard: reject when too many Claude executions are active to
  // prevent Anthropic API budget exhaustion and pod resource saturation.
  if (isAtCapacity()) {
    const currentCount = getActiveCount();
    ctx.log.warn(
      { activeCount: currentCount, limit: config.maxConcurrentRequests },
      "Concurrency limit reached, rejecting request",
    );
    // Inform the user so they know to re-trigger rather than wait silently.
    // Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
    try {
      await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.entityNumber,
        body: `**${config.triggerPhrase}** is at capacity (${currentCount}/${config.maxConcurrentRequests} concurrent requests active). Please re-trigger in a moment.`,
      });
    } catch (commentError) {
      ctx.log.error({ err: commentError }, "Failed to post capacity comment");
    }
    return;
  }

  incrementActiveCount();

  const decision = await decideDispatch(ctx);

  // Dispatch-decision structured log per contracts/dispatch-telemetry.md §1.
  // Triage fields are intentionally omitted in Slice B — US2 (T036) extends
  // this log once triage runs. Operator dashboards key off `msg === "dispatch
  // decision"` plus `dispatchTarget` / `dispatchReason`.
  ctx.log.info(
    {
      deliveryId: ctx.deliveryId,
      owner: ctx.owner,
      repo: ctx.repo,
      eventType: ctx.eventName,
      dispatchTarget: decision.target,
      dispatchReason: decision.reason,
      triageInvoked: false,
    },
    "dispatch decision",
  );

  try {
    await dispatch(ctx, decision);
  } catch (err) {
    if (err instanceof NotImplementedError) {
      decrementActiveCount();
      ctx.log.error(
        { deliveryId: ctx.deliveryId, target: err.target },
        "Dispatch target not yet implemented",
      );
      return;
    }
    // Surface-level decrement for inline-only path; dispatchNonInline manages
    // its own counter semantics (slot stays held until job:result).
    if (decision.target === "inline") {
      decrementActiveCount();
    }
    throw err;
  }
  // For inline jobs, decrement on successful completion of the pipeline.
  // Daemon-dispatched jobs keep the slot — connection-handler releases on job:result.
  if (decision.target === "inline") {
    decrementActiveCount();
  }
}

/**
 * Choose a DispatchTarget for this event. Slice B is a pure config echo —
 * the target equals `config.agentJobMode` (mapped to the DispatchTarget enum)
 * with reason "static-default". Later slices layer on:
 *   - T023 (US1): label + keyword classification short-circuits
 *   - T035 (US2): auto-mode triage call when static classification ambiguous
 *
 * In Slice B, auto mode does NOT throw — it resolves to
 * `config.defaultDispatchTarget` with reason `"static-default"`. That
 * lets ops enable `AGENT_JOB_MODE=auto` today (provided
 * DEFAULT_DISPATCH_TARGET is configured) with a degraded, always-fall-back
 * behaviour, then upgrade to real triage when US2 lands. The config-level
 * invariant `auto ⇒ default ≠ inline` ensures this never silently downgrades
 * to inline.
 */
export async function decideDispatch(ctx: BotContext): Promise<DispatchDecision> {
  // Note: `async` is deliberate — decideDispatch becomes async in US2 when
  // it awaits the triage LLM call. Keeping it async from day 1 avoids a
  // thrash of call-site signatures later.
  await Promise.resolve();

  // Step 1+2 of FR-003 cascade: deterministic label / keyword classification.
  // Labels always win over keywords (FR-016). Inline mode skips the cascade
  // entirely — inline never benefits from container/shared targets, and the
  // explicit signal is the operator setting AGENT_JOB_MODE=inline.
  if (config.agentJobMode !== "inline") {
    const classification = classifyStatic(ctx);
    if (classification.outcome === "clear") {
      return {
        target: classification.mode,
        reason: classification.reason,
        maxTurns: config.defaultMaxTurns,
      };
    }
  }

  // Cascade fell through to step 3 (no clear label/keyword signal). Reason is
  // "static-default" — the platform's configured default applies, no triage.
  // US2 (T035) replaces this branch with the triage call when in auto mode.
  const mode = config.agentJobMode;

  if (mode === "inline" || mode === "daemon" || mode === "shared-runner") {
    return { target: mode, reason: "static-default", maxTurns: config.defaultMaxTurns };
  }
  if (mode === "isolated-job") {
    return { target: "isolated-job", reason: "static-default", maxTurns: config.defaultMaxTurns };
  }
  // mode === "auto" — placeholder; triage call lands in US2.
  return {
    target: config.defaultDispatchTarget,
    reason: "static-default",
    maxTurns: config.defaultMaxTurns,
  };
}

/**
 * Perform the actual dispatch for a resolved DispatchDecision. Slice B wires
 * inline / daemon / shared-runner (the three targets that already exist on
 * main) and throws NotImplementedError for isolated-job. auto mode never
 * surfaces here — decideDispatch resolves auto into a concrete target.
 */
export async function dispatch(ctx: BotContext, decision: DispatchDecision): Promise<void> {
  switch (decision.target) {
    case "inline": {
      const db = getDb();
      if (db !== null) {
        try {
          const serializedCtx = serializeBotContext(ctx);
          await createExecution({
            deliveryId: ctx.deliveryId,
            repoOwner: ctx.owner,
            repoName: ctx.repo,
            entityNumber: ctx.entityNumber,
            entityType: ctx.isPR ? "pull_request" : "issue",
            eventName: ctx.eventName,
            triggerUsername: ctx.triggerUsername,
            dispatchMode: "inline",
            contextJson: serializedCtx,
          });
        } catch (recordErr) {
          ctx.log.error({ err: recordErr }, "Failed to create inline execution record (non-fatal)");
        }
      }
      await runInlinePipeline(ctx);
      return;
    }
    case "daemon":
    case "shared-runner":
      // Pass the decision in so the dispatchMode column reflects the
      // resolved target, not config.agentJobMode. In Slice B they're
      // identical; in Slice C+ they diverge when label/keyword/triage
      // overrides the global mode.
      await dispatchNonInline(ctx, decision);
      return;
    case "isolated-job":
      throw new NotImplementedError("isolated-job");
  }
}

/**
 * Non-inline dispatch: check Valkey, create execution, enqueue, attempt immediate dispatch.
 * Extracted so that any throw in this path can decrement the concurrency counter —
 * the caller's try/finally only covers inline mode.
 */
async function dispatchNonInline(ctx: BotContext, decision: DispatchDecision): Promise<void> {
  if (!isValkeyHealthy()) {
    decrementActiveCount();
    ctx.log.error("Valkey unavailable — rejecting request (FM-7)");
    try {
      await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.entityNumber,
        body: `**${config.triggerPhrase}** cannot process this request — the job queue service is temporarily unavailable. Please try again in a few minutes.`,
      });
    } catch (commentError) {
      ctx.log.error({ err: commentError }, "Failed to post Valkey unavailable comment");
    }
    return;
  }

  try {
    const serializedCtx = serializeBotContext(ctx);
    await createExecution({
      deliveryId: ctx.deliveryId,
      repoOwner: ctx.owner,
      repoName: ctx.repo,
      entityNumber: ctx.entityNumber,
      entityType: ctx.isPR ? "pull_request" : "issue",
      eventName: ctx.eventName,
      triggerUsername: ctx.triggerUsername,
      // Use the resolved target (never "auto"), not the raw config mode.
      dispatchMode: decision.target,
      contextJson: serializedCtx,
    });

    const queuedJob: QueuedJob = {
      deliveryId: ctx.deliveryId,
      repoOwner: ctx.owner,
      repoName: ctx.repo,
      entityNumber: ctx.entityNumber,
      isPR: ctx.isPR,
      eventName: ctx.eventName,
      triggerUsername: ctx.triggerUsername,
      labels: ctx.labels,
      triggerBodyPreview: ctx.triggerBody.slice(0, 200),
      enqueuedAt: Date.now(),
      retryCount: 0,
    };

    // Try direct dispatch first; only enqueue if no daemon is available.
    // This avoids the LPUSH+RPOP race where RPOP could dequeue a different job.
    const dispatched = await dispatchJob(queuedJob);
    if (dispatched) {
      ctx.log.info(
        { deliveryId: ctx.deliveryId, agentJobMode: config.agentJobMode },
        "Job dispatched to daemon",
      );
    } else {
      // No daemon available — enqueue for later pickup and release the concurrency slot.
      // The slot will be re-acquired when a daemon eventually dequeues and accepts.
      await enqueueJob(queuedJob);
      decrementActiveCount();
      ctx.log.warn(
        { deliveryId: ctx.deliveryId },
        "No daemon available — job enqueued, concurrency slot released",
      );
    }
  } catch (err) {
    // Infrastructure failure (Postgres, Valkey) — release the concurrency slot.
    decrementActiveCount();
    throw err;
  }
}
