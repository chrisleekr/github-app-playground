import { config } from "../config";
import { runInlinePipeline } from "../core/inline-pipeline";
import { isAlreadyProcessed, renderQueuePosition } from "../core/tracking-comment";
import { getDb } from "../db";
import { classifyStatic } from "../k8s/classifier";
import { JobSpawnerError, spawnIsolatedJob, watchJobCompletion } from "../k8s/job-spawner";
import {
  enqueuePending,
  inFlightCount,
  type PendingIsolatedJobEntry,
  registerInFlight,
} from "../k8s/pending-queue";
import { dispatchToSharedRunner } from "../k8s/shared-runner-dispatcher";
import {
  decrementActiveCount,
  getActiveCount,
  incrementActiveCount,
  isAtCapacity,
} from "../orchestrator/concurrency";
import { createExecution } from "../orchestrator/history";
import { dispatchJob } from "../orchestrator/job-dispatcher";
import { enqueueJob, type QueuedJob } from "../orchestrator/job-queue";
import { triageRequest, type TriageResult } from "../orchestrator/triage";
import { isValkeyHealthy } from "../orchestrator/valkey";
import type { DispatchReason, DispatchTarget } from "../shared/dispatch-types";
import { type BotContext, serializeBotContext } from "../types";
import { isOwnerAllowed } from "./authorize";
import { getTriageLLMClient } from "./triage-client-factory";

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
 * event. Mirrors data-model.md §5. `triage` is populated only when auto mode
 * actually invoked the triage engine (successfully or not); complexity is
 * carried along for FR-008a maxTurns mapping and for the tracking comment.
 */
export interface DispatchDecision {
  target: DispatchTarget;
  reason: DispatchReason;
  maxTurns: number;
  /** Populated iff triage ran AND parsed (even when sub-threshold). */
  triage?: TriageResult;
  /** Complexity feeds the maxTurns mapping and the tracking comment block. */
  complexity?: "trivial" | "moderate" | "complex";
  /**
   * True iff auto mode actually invoked the triage engine (success,
   * parsed-but-gated, OR errored). Distinct from `triage !== undefined`:
   * parse-error / timeout / llm-error / circuit-open fallbacks all ran the
   * LLM path but produced no parsed result. Used for the `triageInvoked`
   * field on the dispatch-decision log so operators can separate "static
   * cascade chose this" from "triage ran and we recovered".
   */
  triageAttempted?: boolean;
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
/**
 * Emit the dispatch-decision structured log described in
 * `specs/20260415-000159-triage-dispatch-modes/contracts/dispatch-telemetry.md` §1.
 *
 * Extracted from `processRequest` so the contract fields can be
 * asserted directly by unit tests for every `DispatchReason` value
 * without needing to drive the full request path end-to-end.
 *
 * `triageInvoked` tracks "did the LLM path run", not "did we get a
 * parsed result" — the two diverge on parse-error / timeout /
 * llm-error / circuit-open fallbacks where triage ran but produced
 * no structured TriageResult. The `triage*` fields are emitted only
 * when a `TriageResult` is attached to the decision.
 */
export function logDispatchDecision(ctx: BotContext, decision: DispatchDecision): void {
  const triage = decision.triage;
  ctx.log.info(
    {
      deliveryId: ctx.deliveryId,
      owner: ctx.owner,
      repo: ctx.repo,
      eventType: ctx.eventName,
      dispatchTarget: decision.target,
      dispatchReason: decision.reason,
      triageInvoked: decision.triageAttempted === true,
      ...(triage !== undefined && {
        triageConfidence: triage.confidence,
        triageComplexity: triage.complexity,
        triageModel: triage.model,
        triageProvider: triage.provider,
        triageLatencyMs: triage.latencyMs,
        triageCostUsd: triage.costUsd,
      }),
    },
    "dispatch decision",
  );
}

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

  logDispatchDecision(ctx, decision);

  // Targets whose active slot is released at this level (dispatch returns
  // once the work is either complete OR ownership has been handed off).
  // `daemon` is excluded: dispatchNonInline manages its own counter — the
  // slot stays held until job:result arrives from the daemon via WS.
  const releasesSlotHere =
    decision.target === "inline" ||
    decision.target === "shared-runner" ||
    decision.target === "isolated-job";

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
    if (releasesSlotHere) {
      decrementActiveCount();
    }
    throw err;
  }
  if (releasesSlotHere) {
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

  // Cascade fell through to step 3. In auto mode, invoke the probabilistic
  // triage engine; in any other mode, honour the configured target as-is.
  const mode = config.agentJobMode;

  if (mode === "inline" || mode === "daemon" || mode === "shared-runner") {
    return { target: mode, reason: "static-default", maxTurns: config.defaultMaxTurns };
  }
  if (mode === "isolated-job") {
    return { target: "isolated-job", reason: "static-default", maxTurns: config.defaultMaxTurns };
  }

  // mode === "auto" — run triage against the LLM client.
  const triageOutcome = await triageRequest(
    {
      deliveryId: ctx.deliveryId,
      owner: ctx.owner,
      repo: ctx.repo,
      eventName: ctx.eventName,
      isPR: ctx.isPR,
      labels: ctx.labels,
      triggerBody: ctx.triggerBody,
    },
    getTriageLLMClient(),
  );

  if (triageOutcome.outcome === "result") {
    const complexity = triageOutcome.result.complexity;
    return {
      target: triageOutcome.result.mode,
      reason: "triage",
      maxTurns: resolveMaxTurnsForComplexity(complexity),
      triage: triageOutcome.result,
      complexity,
      triageAttempted: true,
    };
  }

  // Fallback branch. `disabled` is the only fallback where the LLM path
  // did NOT run — every other reason means the engine attempted a call
  // (success-but-gated, parse-error, timeout, llm-error, circuit-open).
  const fallbackReason: DispatchReason =
    triageOutcome.reason === "sub-threshold" ? "default-fallback" : "triage-error-fallback";
  const triageAttempted = triageOutcome.reason !== "disabled";
  // When sub-threshold, carry the parsed result through so the router can
  // populate triage_confidence / triage_cost_usd / triage_complexity on
  // the `default-fallback` executions row (FR-014) and emit full telemetry
  // on the dispatch-decision log. Other fallback reasons have no parsed
  // result to carry — the shape stays undefined.
  return {
    target: config.defaultDispatchTarget,
    reason: fallbackReason,
    maxTurns: config.defaultMaxTurns,
    triageAttempted,
    ...(triageOutcome.result !== undefined && {
      triage: triageOutcome.result,
      complexity: triageOutcome.result.complexity,
    }),
  };
}

/**
 * FR-008a: map a coarse complexity estimate onto a concrete `maxTurns`.
 * Operators tune these via TRIAGE_MAXTURNS_{TRIVIAL,MODERATE,COMPLEX}; the
 * default table (10 / 30 / 50) avoids over-allocating turns to events that
 * the classifier deemed trivial.
 */
export function resolveMaxTurnsForComplexity(
  complexity: "trivial" | "moderate" | "complex",
): number {
  switch (complexity) {
    case "trivial":
      return config.triageMaxTurnsTrivial;
    case "moderate":
      return config.triageMaxTurnsModerate;
    case "complex":
      return config.triageMaxTurnsComplex;
  }
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
      await writeExecutionRow(ctx, decision, "inline", "inline");
      await runInlinePipeline(ctx);
      return;
    }
    case "daemon":
      // Daemon target retains the existing Phase 2 orchestrator queue path.
      await dispatchNonInline(ctx, decision);
      return;
    case "shared-runner": {
      // Mirror the inline path: write an executions row before dispatch so the
      // DB/audit trail captures the request regardless of runner outcome.
      // dispatchToSharedRunner itself does NOT persist — it only speaks HTTP.
      await writeExecutionRow(ctx, decision, "shared-runner", "shared-runner");
      await dispatchToSharedRunner(ctx, decision);
      return;
    }
    case "isolated-job":
      await dispatchIsolatedJob(ctx, decision);
      return;
  }
}

/**
 * T044 (US3): wire the Valkey pending queue + in-flight cap into the
 * isolated-job path. Three mutually exclusive outcomes:
 *
 *   1. Under capacity      → `spawnIsolatedJob` + `registerInFlight` (direct).
 *   2. At capacity, queue has room → `enqueuePending`; the drainer picks
 *      the entry up and spawns later. Tracking comment shows "position N of M".
 *   3. At capacity AND queue full  → `capacity-rejected` execution row +
 *      tracking-comment rejection (FR-018: no silent downgrade).
 *
 * Ordering with `infra-absent`: `spawnIsolatedJob` detects missing K8s auth
 * via `loadKubernetesClient()`, which runs AFTER this function's capacity
 * gate. That means on an infra-absent deployment, the FIRST request still
 * hits capacity=0, takes the direct-spawn branch, and fails fast with an
 * infra-absent rejection comment. But once capacity is saturated (e.g. K8s
 * went away AFTER some Jobs were spawned), subsequent requests take the
 * enqueue path and sit in the queue; the drainer later trips the same
 * `infra-absent` and surfaces it on the drained request (see
 * `pending-queue-drainer.ts`). The `SCARD` pre-check here is cheap.
 */
async function dispatchIsolatedJob(ctx: BotContext, decision: DispatchDecision): Promise<void> {
  const inFlight = await inFlightCount();
  if (inFlight >= config.maxConcurrentIsolatedJobs) {
    const entry: PendingIsolatedJobEntry = {
      deliveryId: ctx.deliveryId,
      enqueuedAt: new Date().toISOString(),
      botContextKey: `bot-context:${ctx.deliveryId}`,
      triageResult: decision.triage ?? null,
      dispatchReason: decision.reason,
      maxTurns: decision.maxTurns,
      source: { owner: ctx.owner, repo: ctx.repo, issueOrPrNumber: ctx.entityNumber },
    };
    const outcome = await enqueuePending(entry, serializeBotContext(ctx), {
      maxQueueLength: config.pendingIsolatedJobQueueMax,
    });
    if (outcome.outcome === "rejected-full") {
      await recordCapacityRejection(ctx, decision, outcome.currentLength);
      return;
    }
    await postQueuedTrackingComment(ctx, outcome.position);
    ctx.log.info(
      {
        deliveryId: ctx.deliveryId,
        position: outcome.position,
        inFlight,
        max: config.maxConcurrentIsolatedJobs,
      },
      "isolated-job at capacity — enqueued",
    );
    return;
  }

  try {
    await spawnIsolatedJob(ctx, decision);
  } catch (err) {
    // FR-018 graceful rejection (T025): infra-absent → write a rejection
    // execution row + post a tracking-comment update, do NOT downgrade
    // to a different target. Other JobSpawnerError kinds (auth-load,
    // api-rejected, api-unavailable) bubble to the processRequest
    // catch where they're logged as runtime failures.
    if (err instanceof JobSpawnerError && err.kind === "infra-absent") {
      await recordInfraAbsentRejection(ctx, decision, err.message);
      return;
    }
    throw err;
  }

  // Register AFTER spawn to avoid occupying a slot for a never-created Job.
  // Non-fatal on failure: the Job is running; the in-flight set is a
  // best-effort capacity counter, not a liveness source of truth.
  try {
    await registerInFlight(ctx.deliveryId);
  } catch (err) {
    ctx.log.warn(
      { err, deliveryId: ctx.deliveryId },
      "isolated-job registerInFlight failed — slot accounting may drift",
    );
  }

  // Fire-and-forget completion watcher (T046/T047/T048). Runs in the
  // background for the Job's lifetime; on termination it releases the
  // in-flight slot, and on wall-clock timeout it also updates the
  // executions row. `.catch` exists so a Promise rejection never
  // surfaces as an unhandledRejection — the watcher itself already
  // translates all internal errors to `abandoned`, but the guard is a
  // cheap belt-and-braces against future refactors.
  void watchJobCompletion(ctx.deliveryId).catch((err: unknown) => {
    ctx.log.error(
      { err, deliveryId: ctx.deliveryId },
      "watchJobCompletion threw unexpectedly — in-flight slot may leak",
    );
  });
}

/**
 * US3 queue-full write-path. Persists an execution row with
 * `dispatch_reason="capacity-rejected"` and posts a tracking comment that
 * tells the requester the pool is saturated beyond the queue ceiling. Spec
 * (FR-018) is explicit: NO silent downgrade to shared-runner or daemon.
 */
async function recordCapacityRejection(
  ctx: BotContext,
  decision: DispatchDecision,
  queueLength: number,
): Promise<void> {
  ctx.log.warn(
    {
      deliveryId: ctx.deliveryId,
      target: decision.target,
      queueLength,
      max: config.pendingIsolatedJobQueueMax,
    },
    "isolated-job dispatch rejected — pool at capacity and pending queue full",
  );

  const db = getDb();
  if (db !== null) {
    try {
      await createExecution({
        deliveryId: ctx.deliveryId,
        repoOwner: ctx.owner,
        repoName: ctx.repo,
        entityNumber: ctx.entityNumber,
        entityType: ctx.isPR ? "pull_request" : "issue",
        eventName: ctx.eventName,
        triggerUsername: ctx.triggerUsername,
        dispatchMode: decision.target,
        dispatchReason: "capacity-rejected",
        ...(decision.triage !== undefined && {
          triageConfidence: decision.triage.confidence,
          triageCostUsd: decision.triage.costUsd,
          triageComplexity: decision.triage.complexity,
        }),
        contextJson: serializeBotContext(ctx),
      });
    } catch (recordErr) {
      ctx.log.error(
        { err: recordErr },
        "Failed to write capacity-rejected execution row (non-fatal)",
      );
    }
  }

  try {
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.entityNumber,
      body:
        `**${config.triggerPhrase}** cannot dispatch this request: the \`isolated-job\` pool is at capacity ` +
        `(${String(config.maxConcurrentIsolatedJobs)} in-flight) and the pending queue is full ` +
        `(${String(queueLength)} of ${String(config.pendingIsolatedJobQueueMax)} waiting). ` +
        `The platform will not silently downgrade to a different target — please re-trigger in a few minutes.`,
    });
  } catch (commentError) {
    ctx.log.error({ err: commentError }, "Failed to post capacity-rejected rejection comment");
  }
}

/**
 * Post the initial "⏳ Queued (position N of M)" tracking comment for a
 * pending isolated-job request. The body embeds the delivery marker so the
 * durable idempotency check (`isAlreadyProcessed`) picks it up on a webhook
 * retry while the event is still queued — preventing a second enqueue for
 * the same delivery.
 *
 * The queued comment is deliberately a separate comment from the one the
 * Job entrypoint later posts ("Working…"): the Job's `createTrackingComment`
 * runs inside the isolated pod with a fresh octokit instance, and trying
 * to thread a comment id through the Valkey queue would require extending
 * `SerializableBotContext`. The UX cost is one extra comment in the thread;
 * the engineering cost of threading a mutable id across processes isn't
 * worth paying.
 */
async function postQueuedTrackingComment(ctx: BotContext, position: number): Promise<void> {
  try {
    const body = `<!-- delivery:${ctx.deliveryId} -->\n${renderQueuePosition(position, config.maxConcurrentIsolatedJobs)}`;
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.entityNumber,
      body,
    });
  } catch (commentError) {
    ctx.log.error({ err: commentError }, "Failed to post queued tracking comment");
  }
}

/**
 * Write an `executions` row for a dispatch decision. Extracted helper so
 * every target (inline / shared-runner / daemon) records the same denorm
 * triage fields without duplication. DB write failures are logged but
 * non-fatal — a transient Postgres outage must not block dispatch.
 */
async function writeExecutionRow(
  ctx: BotContext,
  decision: DispatchDecision,
  dispatchMode: string,
  logTag: string,
): Promise<void> {
  const db = getDb();
  if (db === null) return;
  try {
    await createExecution({
      deliveryId: ctx.deliveryId,
      repoOwner: ctx.owner,
      repoName: ctx.repo,
      entityNumber: ctx.entityNumber,
      entityType: ctx.isPR ? "pull_request" : "issue",
      eventName: ctx.eventName,
      triggerUsername: ctx.triggerUsername,
      dispatchMode,
      dispatchReason: decision.reason,
      ...(decision.triage !== undefined && {
        triageConfidence: decision.triage.confidence,
        triageCostUsd: decision.triage.costUsd,
        triageComplexity: decision.triage.complexity,
      }),
      contextJson: serializeBotContext(ctx),
    });
  } catch (recordErr) {
    ctx.log.error({ err: recordErr }, `Failed to create ${logTag} execution record (non-fatal)`);
  }
}

/**
 * FR-018 rejection write-path. Persists an execution row with
 * dispatch_mode="isolated-job" and dispatch_reason="infra-absent", logs the
 * rejection, and posts a tracking comment so the maintainer sees a clear
 * refusal. Never silently downgrades to a different target — that defeats
 * the purpose of asking for isolated execution.
 */
async function recordInfraAbsentRejection(
  ctx: BotContext,
  decision: DispatchDecision,
  reason: string,
): Promise<void> {
  ctx.log.warn(
    { deliveryId: ctx.deliveryId, target: decision.target, reason },
    "isolated-job dispatch rejected — Kubernetes infrastructure absent",
  );

  const db = getDb();
  if (db !== null) {
    try {
      await createExecution({
        deliveryId: ctx.deliveryId,
        repoOwner: ctx.owner,
        repoName: ctx.repo,
        entityNumber: ctx.entityNumber,
        entityType: ctx.isPR ? "pull_request" : "issue",
        eventName: ctx.eventName,
        triggerUsername: ctx.triggerUsername,
        // The target IS isolated-job (the user asked for it); the reason is
        // why we couldn't honour it. data-model.md §4 dispatch_reason enum.
        dispatchMode: decision.target,
        dispatchReason: "infra-absent",
        contextJson: serializeBotContext(ctx),
      });
    } catch (recordErr) {
      ctx.log.error(
        { err: recordErr },
        "Failed to write infra-absent rejection execution row (non-fatal)",
      );
    }
  }

  try {
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.entityNumber,
      body:
        `**${config.triggerPhrase}** cannot dispatch this request: the isolated-job target ` +
        `requires Kubernetes infrastructure that is not currently configured on this server. ` +
        `The platform will not silently downgrade to a different target — please re-trigger ` +
        `without the \`bot:job\` label / docker keyword if shared-runner is acceptable.`,
    });
  } catch (commentError) {
    ctx.log.error({ err: commentError }, "Failed to post infra-absent rejection comment");
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
      dispatchReason: decision.reason,
      ...(decision.triage !== undefined && {
        triageConfidence: decision.triage.confidence,
        triageCostUsd: decision.triage.costUsd,
        triageComplexity: decision.triage.complexity,
      }),
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
