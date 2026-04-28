/**
 * T015: probe-response JSON fixtures must round-trip through verdict.ts
 * unchanged. Locks the fixture set against a verdict-module refactor
 * that silently drifts the contract.
 */

import { describe, expect, it } from "bun:test";

import { computeVerdict, type ProbeResponseShape } from "../../../src/workflows/ship/verdict";
import failingChecks from "./fixtures/probe-responses/failing-checks.json";
import foreignPush from "./fixtures/probe-responses/foreign-push.json";
import ready from "./fixtures/probe-responses/ready.json";

const BOT_LOGIN = "chrisleekr-bot[bot]";

describe("probe-response fixtures (T015)", () => {
  it("ready.json → verdict.ready === true", () => {
    const v = computeVerdict({
      response: ready as unknown as ProbeResponseShape,
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(true);
  });

  it("failing-checks.json → verdict.ready === false, reason='failing_checks'", () => {
    const v = computeVerdict({
      response: failingChecks as unknown as ProbeResponseShape,
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(false);
    if (!v.ready) expect(v.reason).toBe("failing_checks");
  });

  it("foreign-push.json → verdict.ready === false, reason='human_took_over'", () => {
    const v = computeVerdict({
      response: foreignPush as unknown as ProbeResponseShape,
      botAppLogin: BOT_LOGIN,
      botPushedShas: new Set(),
    });
    expect(v.ready).toBe(false);
    if (!v.ready) expect(v.reason).toBe("human_took_over");
  });
});
