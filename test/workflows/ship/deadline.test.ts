/**
 * Tests for `src/workflows/ship/deadline.ts` (T036).
 */

import { describe, expect, it } from "bun:test";

import { config } from "../../../src/config";
import { enforceDeadline, parseDeadlineFlag } from "../../../src/workflows/ship/deadline";

describe("parseDeadlineFlag", () => {
  it("clamps to MAX_WALL_CLOCK_PER_SHIP_RUN when input exceeds it", () => {
    const max = config.maxWallClockPerShipRun;
    const result = parseDeadlineFlag(max + 1_000_000);
    expect(result.deadline_ms).toBe(max);
  });

  it("returns max when input is undefined", () => {
    expect(parseDeadlineFlag(undefined).deadline_ms).toBe(config.maxWallClockPerShipRun);
  });

  it("returns max when input is non-finite or non-positive", () => {
    expect(parseDeadlineFlag(0).deadline_ms).toBe(config.maxWallClockPerShipRun);
    expect(parseDeadlineFlag(-1000).deadline_ms).toBe(config.maxWallClockPerShipRun);
    expect(parseDeadlineFlag(Number.NaN).deadline_ms).toBe(config.maxWallClockPerShipRun);
    expect(parseDeadlineFlag(Number.POSITIVE_INFINITY).deadline_ms).toBe(
      config.maxWallClockPerShipRun,
    );
  });

  it("accepts a valid in-range deadline as-is", () => {
    const requested = Math.min(60 * 60 * 1000, config.maxWallClockPerShipRun);
    expect(parseDeadlineFlag(requested).deadline_ms).toBe(requested);
  });
});

describe("enforceDeadline", () => {
  it("not exceeded when now < deadline_at", () => {
    const future = new Date(Date.now() + 60_000);
    const result = enforceDeadline({ deadline_at: future });
    expect(result.exceeded).toBe(false);
    expect(result.remainingMs).toBeGreaterThan(0);
  });

  it("exceeded when now > deadline_at", () => {
    const past = new Date(Date.now() - 60_000);
    const result = enforceDeadline({ deadline_at: past });
    expect(result.exceeded).toBe(true);
    expect(result.remainingMs).toBeLessThanOrEqual(0);
  });

  it("exceeded when now === deadline_at (boundary)", () => {
    const now = new Date();
    const result = enforceDeadline({ deadline_at: now }, now);
    expect(result.exceeded).toBe(true);
  });
});
