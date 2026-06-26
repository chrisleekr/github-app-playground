/**
 * Minimal three-state circuit breaker used by the triage engine to cap
 * the blast radius of a Claude / Bedrock outage.
 *
 * States (per research.md R7):
 *   - closed     → normal: calls pass through, failures increment a counter
 *   - open       → tripped: calls short-circuit, no network I/O
 *   - half-open  → probe: one call allowed; success closes, failure re-opens
 *
 * Trip conditions:
 *   - 5 consecutive failures (`maxConsecutiveFailures`), OR
 *   - any single call whose observed latency exceeds `latencyTripMs` (10s default)
 *
 * Cooldown: `cooldownMs` (60s default). After cooldown elapses while open,
 * the NEXT call is allowed through as the half-open probe.
 *
 * SC-005 compliance: with a 60s cooldown and 1 probe per cycle, error-path
 * cost is bounded to ~60 calls/hour × ~US$0.001 ≈ US$0.06/hour against the
 * US$1/hour budget.
 */

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Max consecutive failures before tripping open. Default 5. */
  readonly maxConsecutiveFailures?: number;
  /** Any single call longer than this trips open. Default 10_000 ms. */
  readonly latencyTripMs?: number;
  /** Cooldown while open before the next call is admitted. Default 60_000 ms. */
  readonly cooldownMs?: number;
  /**
   * Clock injection point for tests. Production code uses `Date.now`; tests
   * replace this with a mutable value so half-open transitions are
   * deterministic without sleeping.
   */
  readonly now?: () => number;
  /** Optional observer hook, fires on every state transition. */
  readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    reason: string,
  ) => void;
  /**
   * Optional structured-event observer (issue #216). Fires for the events the
   * transition hook cannot see: every short-circuited skip while open, and
   * every recorded failure short of tripping. Lets the caller emit the
   * `circuit.*` log family without reaching into private breaker state.
   */
  readonly onEvent?: (event: CircuitBreakerEvent) => void;
}

/**
 * Structured observability event (issue #216), distinct from `onStateChange`
 * which fires only on transitions. `openMs` is trip→now wall-clock: emitted on
 * the close transition (MTTR) and on each skip (incident duration so far).
 */
export type CircuitBreakerEvent =
  | {
      readonly kind: "opened";
      readonly from: CircuitBreakerState;
      readonly consecutiveFailures: number;
      readonly latencyTripped: boolean;
    }
  | { readonly kind: "half-open"; readonly from: CircuitBreakerState }
  | { readonly kind: "closed"; readonly openMs: number }
  | { readonly kind: "skipped"; readonly openMs: number; readonly skipsSinceOpened: number }
  | {
      readonly kind: "failure";
      readonly consecutiveFailures: number;
      readonly maxConsecutiveFailures: number;
      readonly latencyTripped: boolean;
    };

export interface CircuitBreakerExecuteResult<T> {
  /** The wrapped function's return value, if it ran to completion. */
  readonly value?: T;
  /** `"circuit-open"` when short-circuited; `"ok"` on success; `"error"` on failure. */
  readonly outcome: "ok" | "error" | "circuit-open";
  /** Underlying error when outcome === "error"; undefined otherwise. */
  readonly error?: Error;
  /** Wall-clock latency of the wrapped call. 0 when short-circuited. */
  readonly latencyMs: number;
  /**
   * True when `outcome === "error"` because the call ran to completion but
   * exceeded `latencyTripMs` (issue #216), false otherwise. Lets the caller
   * distinguish "upstream is slow" from "upstream threw" instead of collapsing
   * both into one error reason.
   */
  readonly latencyTripped: boolean;
}

/**
 * Three-state breaker. Not thread-safe in the multi-process sense: the
 * webhook server runs as a single Node-compatible Bun process, so shared
 * in-process state is sufficient. If the process is restarted the breaker
 * resets to `closed`; a fresh outage re-trips it within ≤5 calls.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** Running count of skips in the current open window; reset on each trip. */
  private skipsSinceOpened = 0;

  private readonly maxConsecutiveFailures: number;
  private readonly latencyTripMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    reason: string,
  ) => void;
  private readonly onEvent: (event: CircuitBreakerEvent) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
    this.latencyTripMs = opts.latencyTripMs ?? 10_000;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.onStateChange = opts.onStateChange ?? ((): void => undefined);
    this.onEvent = opts.onEvent ?? ((): void => undefined);
  }

  /** Current state, used by tests and telemetry. */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * @internal Reset the breaker to its initial state. Exposed for tests so
   * modules that hold a long-lived breaker singleton can clear state between
   * cases without casting into private fields. Not intended for production
   * callers: transitions produced this way bypass `onStateChange`.
   */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.skipsSinceOpened = 0;
  }

  /**
   * Execute `fn` under the breaker. Returns an outcome discriminator so the
   * caller can distinguish "didn't run" (circuit-open) from "ran and errored"
   * the two collapse at the router layer but tests assert on them.
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerExecuteResult<T>> {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) {
        this.skipsSinceOpened += 1;
        this.onEvent({
          kind: "skipped",
          openMs: this.now() - this.openedAt,
          skipsSinceOpened: this.skipsSinceOpened,
        });
        return { outcome: "circuit-open", latencyMs: 0, latencyTripped: false };
      }
      this.transition("open", "half-open", "cooldown elapsed");
    }

    const start = this.now();
    try {
      const value = await fn();
      const latencyMs = this.now() - start;
      if (latencyMs > this.latencyTripMs) {
        this.recordFailure(`latency ${latencyMs}ms exceeded ${this.latencyTripMs}ms`, true);
        return {
          value,
          outcome: "error",
          error: new Error(
            `Circuit breaker: latency ${latencyMs}ms > trip ${this.latencyTripMs}ms`,
          ),
          latencyMs,
          latencyTripped: true,
        };
      }
      this.recordSuccess();
      return { value, outcome: "ok", latencyMs, latencyTripped: false };
    } catch (err) {
      const latencyMs = this.now() - start;
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordFailure(error.message, false);
      return { outcome: "error", error, latencyMs, latencyTripped: false };
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      const openMs = this.now() - this.openedAt;
      this.transition("half-open", "closed", "probe succeeded");
      this.onEvent({ kind: "closed", openMs });
    }
  }

  private recordFailure(reason: string, latencyTripped: boolean): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      this.trip(`probe failed: ${reason}`, latencyTripped);
      return;
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trip(
        `${String(this.consecutiveFailures)} consecutive failures; last: ${reason}`,
        latencyTripped,
      );
      return;
    }
    // Pre-trip progress: one warn per failure short of tripping so an operator
    // gets a head start before the breaker opens (issue #216).
    this.onEvent({
      kind: "failure",
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      latencyTripped,
    });
  }

  private trip(reason: string, latencyTripped: boolean): void {
    const from = this.state;
    const consecutiveFailures = this.consecutiveFailures;
    this.openedAt = this.now();
    this.skipsSinceOpened = 0;
    this.state = "open";
    this.onStateChange(from, "open", reason);
    this.onEvent({ kind: "opened", from, consecutiveFailures, latencyTripped });
  }

  private transition(from: CircuitBreakerState, to: CircuitBreakerState, reason: string): void {
    this.state = to;
    if (to === "closed") {
      this.consecutiveFailures = 0;
    }
    this.onStateChange(from, to, reason);
    if (to === "half-open") {
      this.onEvent({ kind: "half-open", from });
    }
  }
}
