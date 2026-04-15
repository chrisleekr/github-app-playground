import { config } from "../config";
import { type BotContext, type ExecutionResult, serializeBotContext } from "../types";
import type { DispatchDecision } from "../webhook/router";

/**
 * Typed errors the dispatcher can throw. Callers (router) inspect `.kind` to
 * decide whether to surface a tracking-comment update vs. retry vs. give up.
 * Plain strings would force string-matching at the call site, which
 * constitution §V calls out as a maintenance hazard.
 */
export type SharedRunnerErrorKind =
  | "validation" // 400 — request body or tool-list rejected
  | "unauthorized" // 401 — bad / missing X-Internal-Token
  | "duplicate" // 409 — delivery-id already in flight
  | "at-capacity" // 429 — runner pool saturated; retried once before throw
  | "internal" // 500 — runner-side failure
  | "timeout" // 504 — runner exceeded its wall-clock budget
  | "network" // fetch threw before a response
  | "unconfigured"; // INTERNAL_RUNNER_URL / TOKEN missing — should be unreachable

export class SharedRunnerError extends Error {
  constructor(
    readonly kind: SharedRunnerErrorKind,
    message: string,
    readonly status?: number,
    readonly executionId?: string,
  ) {
    super(message);
    this.name = "SharedRunnerError";
  }
}

/**
 * Internal runner response envelope. Mirrors the four canonical shapes from
 * `contracts/shared-runner-internal.md` §Responses. Validated with a runtime
 * type guard rather than Zod to avoid a per-call schema-parse overhead — the
 * runner is trusted infrastructure inside the cluster, not a user input.
 */
interface RunnerSuccessResponse {
  ok: true;
  executionId: string;
  costUsd: number;
  durationMs: number;
  turns: number;
  status: "success" | "failure";
}

interface RunnerErrorResponse {
  ok: false;
  error: string;
  message?: string;
  executionId?: string;
}

/**
 * POST /internal/run on the shared-runner pool and return the structured
 * execution outcome. The dispatcher owns:
 *   - building the request body from BotContext + DispatchDecision
 *   - HMAC-style auth via the X-Internal-Token shared secret
 *   - mapping every documented status code to a typed SharedRunnerError
 *   - one retry on 429 (per contract §Responses) before surfacing
 *
 * The dispatcher does NOT own:
 *   - tracking-comment updates — the router/inline-pipeline layer renders
 *     those once the execution settles
 *   - the executions DB row — written by the caller (router) so the dispatch
 *     decision context is available
 *
 * @param ctx - Bot context for the originating webhook
 * @param decision - Resolved dispatch decision (target must be "shared-runner")
 * @returns Execution result mapped from the runner's 200 response
 * @throws {SharedRunnerError} when the runner returns a 4xx/5xx, when fetch
 *         fails, or when INTERNAL_RUNNER_URL/TOKEN is unset
 */
export async function dispatchToSharedRunner(
  ctx: BotContext,
  decision: DispatchDecision,
): Promise<ExecutionResult> {
  const url = config.internalRunnerUrl;
  const token = config.internalRunnerToken;
  if (url === undefined || url === "" || token === undefined || token === "") {
    // Should be unreachable in production: the config schema's superRefine
    // requires both when AGENT_JOB_MODE is shared-runner or auto. Defensive
    // throw guards against direct callers that bypass the router.
    throw new SharedRunnerError(
      "unconfigured",
      "INTERNAL_RUNNER_URL and INTERNAL_RUNNER_TOKEN must be configured before dispatching to the shared runner",
    );
  }

  const body = {
    deliveryId: ctx.deliveryId,
    botContext: serializeBotContext(ctx),
    maxTurns: decision.maxTurns,
    allowedToolsOverride: null,
    traceFields: { dispatchReason: decision.reason },
  };

  // 429 retry: contract §Responses says "dispatcher retries with backoff once,
  // then surfaces". A single 250ms back-off keeps the call fast on capacity
  // blips while not amplifying load on a saturated pool.
  let lastError: SharedRunnerError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const response = await safeFetch(url, token, ctx.deliveryId, body);
    if (response.kind === "throw") {
      throw new SharedRunnerError("network", response.message);
    }

    const parsed = await parseRunnerResponse(response.response);

    if (response.response.status === 200 && parsed.kind === "success") {
      return {
        success: parsed.body.status === "success",
        costUsd: parsed.body.costUsd,
        durationMs: parsed.body.durationMs,
        numTurns: parsed.body.turns,
      };
    }

    const errorBody = parsed.kind === "error" ? parsed.body : undefined;
    const status = response.response.status;

    if (status === 429) {
      lastError = new SharedRunnerError(
        "at-capacity",
        errorBody?.error ?? "shared-runner pool at capacity",
        status,
      );
      continue; // retry once
    }

    throw mapStatusToError(status, errorBody);
  }

  // Both attempts returned 429.
  throw lastError ?? new SharedRunnerError("at-capacity", "shared-runner saturated", 429);
}

/**
 * Dispatch HTTP errors from fetch() distinct from runner-protocol errors.
 * `safeFetch` returns either the response (success or any HTTP status) or a
 * structured error object describing the throw. This keeps the call-site
 * try/catch from swallowing important diagnostics.
 */
async function safeFetch(
  url: string,
  token: string,
  deliveryId: string,
  body: unknown,
): Promise<{ kind: "response"; response: Response } | { kind: "throw"; message: string }> {
  try {
    const response = await fetch(`${url}/internal/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": token,
        "X-Request-Id": deliveryId,
      },
      body: JSON.stringify(body),
    });
    return { kind: "response", response };
  } catch (err) {
    return {
      kind: "throw",
      message: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

/**
 * Read and parse the runner response body. The body shape depends on status
 * (200 → success envelope, 4xx/5xx → error envelope). Both are JSON; if the
 * body fails to parse, fall back to a synthetic error envelope so callers
 * don't need a separate try/catch.
 */
async function parseRunnerResponse(
  response: Response,
): Promise<
  { kind: "success"; body: RunnerSuccessResponse } | { kind: "error"; body: RunnerErrorResponse }
> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      kind: "error",
      body: { ok: false, error: "non-json-response" },
    };
  }
  if (isSuccessResponse(raw)) {
    return { kind: "success", body: raw };
  }
  if (isErrorResponse(raw)) {
    return { kind: "error", body: raw };
  }
  return { kind: "error", body: { ok: false, error: "malformed-response" } };
}

function isSuccessResponse(value: unknown): value is RunnerSuccessResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["ok"] === true &&
    typeof v["executionId"] === "string" &&
    typeof v["costUsd"] === "number" &&
    typeof v["durationMs"] === "number" &&
    typeof v["turns"] === "number" &&
    (v["status"] === "success" || v["status"] === "failure")
  );
}

function isErrorResponse(value: unknown): value is RunnerErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["ok"] === false && typeof v["error"] === "string";
}

function mapStatusToError(
  status: number,
  body: RunnerErrorResponse | undefined,
): SharedRunnerError {
  const detail = body?.message ?? body?.error ?? `runner returned ${status}`;
  switch (status) {
    case 400:
      return new SharedRunnerError("validation", detail, status);
    case 401:
      return new SharedRunnerError("unauthorized", detail, status);
    case 409:
      return new SharedRunnerError("duplicate", detail, status, body?.executionId);
    case 500:
      return new SharedRunnerError("internal", detail, status, body?.executionId);
    case 504:
      return new SharedRunnerError("timeout", detail, status, body?.executionId);
    default:
      return new SharedRunnerError("internal", detail, status, body?.executionId);
  }
}
