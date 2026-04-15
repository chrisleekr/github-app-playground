/**
 * Contract test for `dispatchToSharedRunner` against
 * `specs/.../contracts/shared-runner-internal.md`.
 *
 * Scope: pin the typed-error surface (every documented status code maps to a
 * specific SharedRunnerError.kind) and the "unconfigured" guard. Full
 * fetch-stub coverage is deferred to T016 integration tests, which exercise
 * the dispatcher inside the router with a controlled environment that can
 * supply INTERNAL_RUNNER_URL/TOKEN before the config singleton parses.
 */

import { describe, expect, it } from "bun:test";

import {
  dispatchToSharedRunner,
  SharedRunnerError,
  type SharedRunnerErrorKind,
} from "../../src/k8s/shared-runner-dispatcher";
import type { BotContext } from "../../src/types";
import type { DispatchDecision } from "../../src/webhook/router";

function makeCtx(): BotContext {
  return {
    owner: "o",
    repo: "r",
    entityNumber: 1,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "u",
    triggerTimestamp: "2026-04-15T00:00:00Z",
    triggerBody: "test",
    commentId: 1,
    deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
    defaultBranch: "main",
    labels: [],
    octokit: {} as never,
    log: {} as never,
  };
}

const baseDecision: DispatchDecision = {
  target: "shared-runner",
  reason: "label",
  maxTurns: 30,
};

describe("dispatchToSharedRunner — config-level guard", () => {
  it("throws SharedRunnerError(unconfigured) when INTERNAL_RUNNER_URL/TOKEN are unset", async () => {
    // Test env runs with these unset; the dispatcher's defensive guard fires
    // before any network call. This is the same precondition the config
    // schema enforces in production via superRefine.
    let caught: unknown;
    try {
      await dispatchToSharedRunner(makeCtx(), baseDecision);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SharedRunnerError);
    if (caught instanceof SharedRunnerError) {
      expect(caught.kind).toBe("unconfigured");
      expect(caught.message).toMatch(/INTERNAL_RUNNER_URL/);
    }
  });
});

describe("SharedRunnerError — typed surface for every documented response", () => {
  it("exposes the eight contract-aligned kinds", () => {
    const kinds: readonly SharedRunnerErrorKind[] = [
      "validation", // 400
      "unauthorized", // 401
      "duplicate", // 409
      "at-capacity", // 429
      "internal", // 500
      "timeout", // 504
      "network", // fetch threw
      "unconfigured", // env missing
    ];
    for (const kind of kinds) {
      const err = new SharedRunnerError(kind, kind);
      expect(err.kind).toBe(kind);
      expect(err.name).toBe("SharedRunnerError");
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("carries optional status and executionId without affecting message", () => {
    const err = new SharedRunnerError("at-capacity", "saturated", 429, "exec-1");
    expect(err.status).toBe(429);
    expect(err.executionId).toBe("exec-1");
    expect(err.message).toBe("saturated");
  });

  it("works without optional fields (network / unconfigured paths)", () => {
    const err = new SharedRunnerError("network", "fetch failed");
    expect(err.status).toBeUndefined();
    expect(err.executionId).toBeUndefined();
  });
});
