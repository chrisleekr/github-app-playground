import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { config } from "../../src/config";
import {
  _resetEphemeralScalerForTests,
  decideEphemeralSpawn,
  markSpawn,
} from "../../src/orchestrator/ephemeral-daemon-scaler";

const origThreshold = config.ephemeralDaemonSpawnQueueThreshold;
const origCooldown = config.ephemeralDaemonSpawnCooldownMs;

beforeEach(() => {
  _resetEphemeralScalerForTests();
  (
    config as unknown as { ephemeralDaemonSpawnQueueThreshold: number }
  ).ephemeralDaemonSpawnQueueThreshold = 3;
  (config as unknown as { ephemeralDaemonSpawnCooldownMs: number }).ephemeralDaemonSpawnCooldownMs =
    30_000;
});

afterEach(() => {
  (
    config as unknown as { ephemeralDaemonSpawnQueueThreshold: number }
  ).ephemeralDaemonSpawnQueueThreshold = origThreshold;
  (config as unknown as { ephemeralDaemonSpawnCooldownMs: number }).ephemeralDaemonSpawnCooldownMs =
    origCooldown;
});

describe("decideEphemeralSpawn", () => {
  it("returns no-signal when not heavy and queue below threshold", () => {
    const verdict = decideEphemeralSpawn({
      heavy: false,
      queueLength: 0,
      persistentFreeSlots: 5,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: false, skipReason: "no-signal" });
  });

  it("spawns with triage-heavy trigger when heavy signal present", () => {
    const verdict = decideEphemeralSpawn({
      heavy: true,
      queueLength: 0,
      persistentFreeSlots: 5,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: true, trigger: "triage-heavy" });
  });

  it("spawns with queue-overflow trigger when queue at threshold AND pool saturated", () => {
    const verdict = decideEphemeralSpawn({
      heavy: false,
      queueLength: 3,
      persistentFreeSlots: 0,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: true, trigger: "queue-overflow" });
  });

  it("does not spawn on queue depth alone when persistent slots are free", () => {
    const verdict = decideEphemeralSpawn({
      heavy: false,
      queueLength: 10,
      persistentFreeSlots: 1,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: false, skipReason: "no-signal" });
  });

  it("prefers triage-heavy over queue-overflow when both fire", () => {
    const verdict = decideEphemeralSpawn({
      heavy: true,
      queueLength: 10,
      persistentFreeSlots: 0,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: true, trigger: "triage-heavy" });
  });

  it("skips with cooldown reason after a recent spawn", () => {
    markSpawn(1_000_000);
    const verdict = decideEphemeralSpawn({
      heavy: true,
      queueLength: 0,
      persistentFreeSlots: 5,
      now: 1_000_000 + 15_000,
    });
    expect(verdict).toEqual({ spawn: false, skipReason: "cooldown" });
  });

  it("allows a fresh spawn once the cooldown window elapses", () => {
    markSpawn(1_000_000);
    const verdict = decideEphemeralSpawn({
      heavy: true,
      queueLength: 0,
      persistentFreeSlots: 5,
      now: 1_000_000 + 30_000,
    });
    expect(verdict).toEqual({ spawn: true, trigger: "triage-heavy" });
  });

  it("treats negative persistentFreeSlots as saturated", () => {
    const verdict = decideEphemeralSpawn({
      heavy: false,
      queueLength: 3,
      persistentFreeSlots: -1,
      now: 1_000_000,
    });
    expect(verdict).toEqual({ spawn: true, trigger: "queue-overflow" });
  });
});
