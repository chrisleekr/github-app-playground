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
  /** Optional observer hook — fires on every state transition. */
  readonly onStateChange?: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    reason: string,
  ) => void;
}

export interface CircuitBreakerExecuteResult<T> {
  /** The wrapped function's return value, if it ran to completion. */
  readonly value?: T;
  /** `"circuit-open"` when short-circuited; `"ok"` on success; `"error"` on failure. */
  readonly outcome: "ok" | "error" | "circuit-open";
  /** Underlying error when outcome === "error"; undefined otherwise. */
  readonly error?: Error;
  /** Wall-clock latency of the wrapped call. 0 when short-circuited. */
  readonly latencyMs: number;
}

/**
 * Three-state breaker. Not thread-safe in the multi-process sense — the
 * webhook server runs as a single Node-compatible Bun process, so shared
 * in-process state is sufficient. If the process is restarted the breaker
 * resets to `closed`; a fresh outage re-trips it within ≤5 calls.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  private readonly maxConsecutiveFailures: number;
  private readonly latencyTripMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange: (
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    reason: string,
  ) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
    this.latencyTripMs = opts.latencyTripMs ?? 10_000;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.onStateChange = opts.onStateChange ?? ((): void => undefined);
  }

  /** Current state — used by tests and telemetry. */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * @internal Reset the breaker to its initial state. Exposed for tests so
   * modules that hold a long-lived breaker singleton can clear state between
   * cases without casting into private fields. Not intended for production
   * callers — transitions produced this way bypass `onStateChange`.
   */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  /**
   * Execute `fn` under the breaker. Returns an outcome discriminator so the
   * caller can distinguish "didn't run" (circuit-open) from "ran and errored"
   * — the two collapse at the router layer but tests assert on them.
   */
  async execute<T>(fn: () => Promise<T>): Promise<CircuitBreakerExecuteResult<T>> {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.cooldownMs) {
        return { outcome: "circuit-open", latencyMs: 0 };
      }
      this.transition("open", "half-open", "cooldown elapsed");
    }

    const start = this.now();
    try {
      const value = await fn();
      const latencyMs = this.now() - start;
      if (latencyMs > this.latencyTripMs) {
        this.recordFailure(`latency ${latencyMs}ms exceeded ${this.latencyTripMs}ms`);
        return {
          value,
          outcome: "error",
          error: new Error(
            `Circuit breaker: latency ${latencyMs}ms > trip ${this.latencyTripMs}ms`,
          ),
          latencyMs,
        };
      }
      this.recordSuccess();
      return { value, outcome: "ok", latencyMs };
    } catch (err) {
      const latencyMs = this.now() - start;
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordFailure(error.message);
      return { outcome: "error", error, latencyMs };
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.transition("half-open", "closed", "probe succeeded");
    }
  }

  private recordFailure(reason: string): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      this.trip(`probe failed: ${reason}`);
      return;
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trip(`${String(this.consecutiveFailures)} consecutive failures; last: ${reason}`);
    }
  }

  private trip(reason: string): void {
    this.openedAt = this.now();
    const from = this.state;
    this.state = "open";
    this.onStateChange(from, "open", reason);
  }

  private transition(from: CircuitBreakerState, to: CircuitBreakerState, reason: string): void {
    this.state = to;
    if (to === "closed") {
      this.consecutiveFailures = 0;
    }
    this.onStateChange(from, to, reason);
  }
}
