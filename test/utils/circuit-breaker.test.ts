import { describe, expect, it } from "bun:test";

import { CircuitBreaker } from "../../src/utils/circuit-breaker";

/**
 * Test scaffold: a mutable clock so cooldown transitions are deterministic
 * without sleeping. Every test starts from a fresh breaker + fresh clock.
 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe("CircuitBreaker — state transitions (closed → open → half-open → closed)", () => {
  it("stays closed while calls succeed", async () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 10; i += 1) {
      const r = await b.execute(() => Promise.resolve("ok"));
      expect(r.outcome).toBe("ok");
    }
    expect(b.getState()).toBe("closed");
  });

  it("trips open after 5 consecutive failures", async () => {
    const b = new CircuitBreaker({ maxConsecutiveFailures: 5 });
    for (let i = 0; i < 4; i += 1) {
      const r = await b.execute(() => Promise.reject(new Error("boom")));
      expect(r.outcome).toBe("error");
      expect(b.getState()).toBe("closed");
    }
    const r5 = await b.execute(() => Promise.reject(new Error("boom")));
    expect(r5.outcome).toBe("error");
    expect(b.getState()).toBe("open");
  });

  it("short-circuits while open (no fn invocation)", async () => {
    const b = new CircuitBreaker({ maxConsecutiveFailures: 1 });
    await b.execute(() => Promise.reject(new Error("x")));
    expect(b.getState()).toBe("open");
    let invoked = false;
    const r = await b.execute(() => {
      invoked = true;
      return Promise.resolve("never");
    });
    expect(invoked).toBe(false);
    expect(r.outcome).toBe("circuit-open");
    expect(r.latencyMs).toBe(0);
  });

  it("transitions open → half-open after cooldown elapses", async () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      maxConsecutiveFailures: 1,
      cooldownMs: 60_000,
      now: clock.now,
    });
    await b.execute(() => Promise.reject(new Error("x")));
    expect(b.getState()).toBe("open");
    clock.advance(59_999);
    const stillOpen = await b.execute(() => Promise.resolve("ok"));
    expect(stillOpen.outcome).toBe("circuit-open");
    expect(b.getState()).toBe("open");
    clock.advance(2);
    const probe = await b.execute(() => Promise.resolve("ok"));
    expect(probe.outcome).toBe("ok");
    expect(b.getState()).toBe("closed");
  });

  it("half-open → open on probe failure (doesn't require 5 more failures)", async () => {
    const clock = makeClock();
    const b = new CircuitBreaker({
      maxConsecutiveFailures: 1,
      cooldownMs: 1_000,
      now: clock.now,
    });
    await b.execute(() => Promise.reject(new Error("x")));
    clock.advance(1_001);
    const probe = await b.execute(() => Promise.reject(new Error("probe-fail")));
    expect(probe.outcome).toBe("error");
    expect(b.getState()).toBe("open");
  });
});

describe("CircuitBreaker — latency trip", () => {
  it("trips on a single slow call exceeding latencyTripMs", async () => {
    let t = 0;
    const clock = {
      now: () => t,
      advance: (ms: number): void => {
        t += ms;
      },
    };
    const b = new CircuitBreaker({
      maxConsecutiveFailures: 5,
      latencyTripMs: 100,
      now: clock.now,
    });
    const r = await b.execute(() => {
      clock.advance(250);
      return Promise.resolve("slow-ok");
    });
    // The call itself resolved successfully, but the breaker flags it as
    // error because latency exceeded the trip threshold.
    expect(r.outcome).toBe("error");
    expect(r.latencyMs).toBe(250);
  });
});

describe("CircuitBreaker — observer hook", () => {
  it("fires onStateChange exactly at each transition", async () => {
    const events: string[] = [];
    const clock = makeClock();
    const b = new CircuitBreaker({
      maxConsecutiveFailures: 1,
      cooldownMs: 10,
      now: clock.now,
      onStateChange: (from, to) => events.push(`${from}->${to}`),
    });
    await b.execute(() => Promise.reject(new Error("x"))); // closed -> open
    clock.advance(11);
    await b.execute(() => Promise.resolve("y")); // open -> half-open -> closed
    expect(events).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });
});

describe("CircuitBreaker — failure counter reset on success", () => {
  it("resets consecutive-failure count after any success", async () => {
    const b = new CircuitBreaker({ maxConsecutiveFailures: 3 });
    await b.execute(() => Promise.reject(new Error("a")));
    await b.execute(() => Promise.reject(new Error("b")));
    await b.execute(() => Promise.resolve("ok"));
    // 2 failures + 1 success → counter reset. 2 more failures must NOT trip.
    await b.execute(() => Promise.reject(new Error("c")));
    await b.execute(() => Promise.reject(new Error("d")));
    expect(b.getState()).toBe("closed");
    // But the 3rd failure in a row (after reset) DOES trip.
    await b.execute(() => Promise.reject(new Error("e")));
    expect(b.getState()).toBe("open");
  });
});

describe("CircuitBreaker — reset()", () => {
  it("returns a tripped breaker to closed", async () => {
    // Replaces brittle private-field casts previously used for test
    // cleanup (Copilot PR #20 feedback).
    const b = new CircuitBreaker({ maxConsecutiveFailures: 2 });
    await b.execute(() => Promise.reject(new Error("x")));
    await b.execute(() => Promise.reject(new Error("y")));
    expect(b.getState()).toBe("open");
    b.reset();
    expect(b.getState()).toBe("closed");
    // Full failure budget is available again.
    await b.execute(() => Promise.reject(new Error("z")));
    expect(b.getState()).toBe("closed");
  });
});
