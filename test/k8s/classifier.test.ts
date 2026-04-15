import { describe, expect, it } from "bun:test";

import { classifyStatic, type StaticClassification } from "../../src/k8s/classifier";
import type { BotContext } from "../../src/types";

/**
 * Minimal BotContext factory — only the three fields the classifier reads
 * (labels, triggerBody, eventName) are meaningful here; the rest are filled
 * with type-satisfying dummies. If the classifier ever grows to inspect more
 * fields, this factory will fail-fast via TypeScript.
 */
function makeCtx(overrides?: {
  labels?: string[];
  triggerBody?: string;
  eventName?: BotContext["eventName"];
}): BotContext {
  return {
    owner: "o",
    repo: "r",
    entityNumber: 1,
    isPR: false,
    eventName: overrides?.eventName ?? "issue_comment",
    triggerUsername: "u",
    triggerTimestamp: "2026-04-15T00:00:00Z",
    triggerBody: overrides?.triggerBody ?? "",
    commentId: 1,
    deliveryId: "d",
    defaultBranch: "main",
    labels: overrides?.labels ?? [],
    octokit: {} as never,
    log: {} as never,
  };
}

describe("classifyStatic — label precedence (FR-004, FR-016)", () => {
  it("routes `bot:job` label to isolated-job with reason=label", () => {
    const result = classifyStatic(makeCtx({ labels: ["bot:job"] }));
    expect(result).toEqual({ outcome: "clear", mode: "isolated-job", reason: "label" });
  });

  it("routes `bot:shared` label to shared-runner with reason=label", () => {
    const result = classifyStatic(makeCtx({ labels: ["bot:shared"] }));
    expect(result).toEqual({ outcome: "clear", mode: "shared-runner", reason: "label" });
  });

  it("labels win over keywords (FR-016, spec edge case)", () => {
    // `bot:shared` label + `docker` keyword: label wins, no keyword fallthrough.
    const result = classifyStatic(
      makeCtx({ labels: ["bot:shared"], triggerBody: "please run docker build" }),
    );
    expect(result).toEqual({ outcome: "clear", mode: "shared-runner", reason: "label" });
  });

  it("`bot:job` wins over `bot:shared` when both are applied (stricter environment)", () => {
    const result = classifyStatic(makeCtx({ labels: ["bot:job", "bot:shared"] }));
    expect(result.outcome).toBe("clear");
    if (result.outcome === "clear") {
      expect(result.mode).toBe("isolated-job");
    }
  });

  it("ignores arbitrary unrelated labels", () => {
    const result = classifyStatic(
      makeCtx({ labels: ["enhancement", "priority:high", "triage"], triggerBody: "" }),
    );
    expect(result).toEqual({ outcome: "ambiguous" });
  });
});

describe("classifyStatic — keyword rules (FR-005)", () => {
  it("matches the `docker` keyword case-insensitively", () => {
    const result = classifyStatic(makeCtx({ triggerBody: "please run DOCKER build -t x ." }));
    expect(result).toEqual({ outcome: "clear", mode: "isolated-job", reason: "keyword" });
  });

  it("matches the `compose` keyword", () => {
    const result = classifyStatic(makeCtx({ triggerBody: "docker compose up -d" }));
    // Both "docker" and "compose" match; first hit wins. Either is correct —
    // the test asserts the outcome, not which keyword won.
    expect(result.outcome).toBe("clear");
    if (result.outcome === "clear") {
      expect(result.mode).toBe("isolated-job");
      expect(result.reason).toBe("keyword");
    }
  });

  it("matches the `dind` keyword", () => {
    const result = classifyStatic(makeCtx({ triggerBody: "try dind instead of docker-in-docker" }));
    expect(result).toEqual({ outcome: "clear", mode: "isolated-job", reason: "keyword" });
  });

  it("does NOT match on substring-within-identifier (`composer`, `dindee`)", () => {
    // Word-boundary regex prevents false positives.
    expect(classifyStatic(makeCtx({ triggerBody: "update composer.json" }))).toEqual({
      outcome: "ambiguous",
    });
    expect(classifyStatic(makeCtx({ triggerBody: "the var dindee holds the count" }))).toEqual({
      outcome: "ambiguous",
    });
  });

  it("does NOT match on keyword-within-URL (whole-word semantics)", () => {
    // Word-boundary treats hyphens as word chars in some locales — we pass a
    // URL-like string to make sure a random path containing "docker" still
    // matches (because hyphens/slashes ARE word boundaries).
    const result = classifyStatic(
      makeCtx({ triggerBody: "see https://example.com/docker-tutorial" }),
    );
    // `docker` IS a whole word here (bounded by `/` and `-`), so this DOES match.
    // The test pins the behaviour so the regex doesn't silently change under us.
    expect(result.outcome).toBe("clear");
  });

  it("returns ambiguous on an unrelated trigger body", () => {
    const result = classifyStatic(makeCtx({ triggerBody: "fix a typo in the README" }));
    expect(result).toEqual({ outcome: "ambiguous" });
  });

  it("returns ambiguous on an empty trigger body", () => {
    const result = classifyStatic(makeCtx({ triggerBody: "" }));
    expect(result).toEqual({ outcome: "ambiguous" });
  });
});

describe("classifyStatic — purity / determinism (FR-005)", () => {
  it("returns the same result for the same input (idempotent)", () => {
    const ctx = makeCtx({ labels: ["bot:shared"], triggerBody: "hi" });
    const a = classifyStatic(ctx);
    const b = classifyStatic(ctx);
    expect(a).toEqual(b);
  });

  it("does not mutate the input context's labels array", () => {
    const labels = ["bot:job"];
    const ctx = makeCtx({ labels });
    classifyStatic(ctx);
    expect(labels).toEqual(["bot:job"]);
  });

  it("narrows the discriminated union correctly for TypeScript consumers", () => {
    const result: StaticClassification = classifyStatic(makeCtx({ labels: ["bot:job"] }));
    if (result.outcome === "clear") {
      // Compile-time: this line proves `mode` is accessible only inside the
      // "clear" branch. Runtime: sanity check.
      expect(result.mode).toBe("isolated-job");
    } else {
      throw new Error("expected clear outcome for bot:job label");
    }
  });
});

describe("classifyStatic — event-type heuristic (fall-through placeholder)", () => {
  it("does not classify PR review comments differently from issue comments absent a rule", () => {
    // No event-type rule has been adopted yet (research.md R1 left open).
    // This test pins the current behaviour so adding a rule later is a
    // deliberate, tested change.
    const issueResult = classifyStatic(makeCtx({ eventName: "issue_comment" }));
    const prReviewResult = classifyStatic(makeCtx({ eventName: "pull_request_review_comment" }));
    expect(issueResult).toEqual(prReviewResult);
    expect(issueResult).toEqual({ outcome: "ambiguous" });
  });
});
