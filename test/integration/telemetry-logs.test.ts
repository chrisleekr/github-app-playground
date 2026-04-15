/**
 * T053 — structured-log contract for dispatch decisions.
 *
 * Exercises every `DispatchReason` value against
 * `logDispatchDecision(ctx, decision)` and asserts the emitted
 * `ctx.log.info("dispatch decision", ...)` record matches
 * `contracts/dispatch-telemetry.md` §1 — including the triage-*
 * field rules (present only when `decision.triage` is populated,
 * which in turn happens only on the triage / default-fallback
 * cascade).
 *
 * The helper is extracted from `processRequest` specifically so this
 * contract can be tested without spinning up octokit / triage / K8s
 * stubs. Every reason that the router may emit on a real request
 * reaches the log through exactly this helper.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import {
  DISPATCH_REASONS,
  type DispatchReason,
  type DispatchTarget,
} from "../../src/shared/dispatch-types";
import type { BotContext } from "../../src/types";
import { type DispatchDecision, logDispatchDecision } from "../../src/webhook/router";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface LogCall {
  readonly fields: Record<string, unknown>;
  readonly msg: string;
}

function makeSpyLog(): { log: BotContext["log"]; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const capture = (fields: Record<string, unknown>, msg: string): void => {
    calls.push({ fields, msg });
  };
  const spy = {
    info: mock(capture),
    warn: mock(capture),
    error: mock(capture),
    debug: mock(capture),
    child: mock((): typeof spy => spy),
  } as unknown as BotContext["log"];
  return { log: spy, calls };
}

let deliveryCounter = 0;

function makeCtx(log: BotContext["log"]): BotContext {
  deliveryCounter++;
  return {
    owner: "chrisleekr",
    repo: "github-app-playground",
    entityNumber: deliveryCounter,
    isPR: false,
    eventName: "issue_comment.created",
    triggerUsername: "alice",
    triggerTimestamp: "2026-04-16T00:00:00Z",
    triggerBody: "@chrisleekr-bot help",
    commentId: deliveryCounter,
    deliveryId: `del-log-${deliveryCounter}`,
    defaultBranch: "main",
    octokit: {} as unknown as Octokit,
    log,
  } as BotContext;
}

const triageFixture = {
  complexity: "moderate" as const,
  confidence: 0.92,
  rationale: "test rationale",
  costUsd: 0.00094,
  latencyMs: 327,
  provider: "anthropic" as const,
  model: "haiku-3-5",
};

// Per §1, `triage*` fields are populated only on the triage cascade.
// `triageAttempted` may still be true for the error-fallback path even
// when the parsed `triage` result is undefined.
const REASONS_WITH_TRIAGE = new Set<DispatchReason>(["triage", "default-fallback"]);
const REASONS_WITH_ATTEMPT_ONLY = new Set<DispatchReason>(["triage-error-fallback"]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch-decision structured log — contract §1", () => {
  for (const reason of DISPATCH_REASONS) {
    it(`emits contract fields for reason="${reason}"`, () => {
      const target: DispatchTarget = reason === "static-default" ? "inline" : "shared-runner";
      const triageAttempted =
        REASONS_WITH_TRIAGE.has(reason) || REASONS_WITH_ATTEMPT_ONLY.has(reason);
      const triage = REASONS_WITH_TRIAGE.has(reason) ? triageFixture : undefined;

      const decision: DispatchDecision = {
        target,
        reason,
        maxTurns: 30,
        triageAttempted,
        ...(triage !== undefined && { triage }),
      };

      const { log, calls } = makeSpyLog();
      const ctx = makeCtx(log);

      logDispatchDecision(ctx, decision);

      const entry = calls.find((c) => c.msg === "dispatch decision");
      expect(entry).toBeDefined();
      const fields = entry?.fields ?? {};

      expect(fields["deliveryId"]).toBe(ctx.deliveryId);
      expect(fields["owner"]).toBe(ctx.owner);
      expect(fields["repo"]).toBe(ctx.repo);
      expect(fields["eventType"]).toBe(ctx.eventName);
      expect(fields["dispatchTarget"]).toBe(target);
      expect(fields["dispatchReason"]).toBe(reason);
      expect(typeof fields["triageInvoked"]).toBe("boolean");
      expect(fields["triageInvoked"]).toBe(triageAttempted);

      if (triage !== undefined) {
        expect(fields["triageConfidence"]).toBe(triage.confidence);
        expect(fields["triageComplexity"]).toBe(triage.complexity);
        expect(fields["triageModel"]).toBe(triage.model);
        expect(fields["triageProvider"]).toBe(triage.provider);
        expect(fields["triageLatencyMs"]).toBe(triage.latencyMs);
        expect(fields["triageCostUsd"]).toBe(triage.costUsd);
      } else {
        // Absent (not undefined / null) so downstream aggregators
        // don't silently count zeros into "triage invoked" buckets.
        expect(fields).not.toHaveProperty("triageConfidence");
        expect(fields).not.toHaveProperty("triageComplexity");
        expect(fields).not.toHaveProperty("triageModel");
        expect(fields).not.toHaveProperty("triageProvider");
        expect(fields).not.toHaveProperty("triageLatencyMs");
        expect(fields).not.toHaveProperty("triageCostUsd");
      }
    });
  }
});
