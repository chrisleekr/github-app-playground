/**
 * T014c — NL intent-classifier tests covering FR-025 + FR-025a.
 *
 * The mention-prefix gate is THE cost-control gate: a comment that does
 * not start with the configured `triggerPhrase` MUST NOT invoke the
 * Bedrock SDK at all. These tests assert zero LLM calls on every
 * non-mentioning input — adding tokens to a maintainer's bill for an
 * irrelevant comment is the failure mode this gate prevents.
 */

import { describe, expect, it, mock } from "bun:test";

import { classifyComment, toCommandIntent } from "../../../src/workflows/ship/nl-classifier";

describe("classifyComment — FR-025a mention-prefix gate", () => {
  it("returns null and does NOT invoke the LLM when the comment lacks the trigger phrase", async () => {
    const callLlm = mock(() => Promise.reject(new Error("must not be called")));
    const result = await classifyComment({
      commentBody: "I think we should ship this PR",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    expect(result).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("returns null when the trigger-phrase substring appears mid-comment (must be prefix)", async () => {
    const callLlm = mock(() => Promise.reject(new Error("must not be called")));
    const result = await classifyComment({
      commentBody: "well @chrisleekr-bot would say ship",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    expect(result).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("rejects a longer login that shares the prefix (token boundary check)", async () => {
    const callLlm = mock(() => Promise.reject(new Error("must not be called")));
    const result = await classifyComment({
      commentBody: "@chrisleekr-bot-foo ship this",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    expect(result).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("returns null when the comment is just the prefix with nothing after it", async () => {
    const callLlm = mock(() => Promise.reject(new Error("must not be called")));
    const result = await classifyComment({
      commentBody: "@chrisleekr-bot   ",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    expect(result).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("forwards only the post-mention substring to the LLM (gate strips the trigger)", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "ship" })));
    await classifyComment({
      commentBody: "@chrisleekr-bot ship this please",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toBe("ship this please");
    expect(userPrompt).not.toContain("@chrisleekr-bot");
  });

  it("trims leading whitespace before checking the prefix", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "ship" })));
    const result = await classifyComment({
      commentBody: "   @chrisleekr-bot ship",
      triggerPhrase: "@chrisleekr-bot",
      callLlm,
    });
    expect(result?.intent).toBe("ship");
  });
});

describe("classifyComment — JSON shape + Zod validation", () => {
  it("returns the parsed result for representative ship phrasing", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ intent: "ship", deadline_ms: 7_200_000 })),
    );
    const result = await classifyComment({
      commentBody: "@bot give it 2 hours",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "ship", deadline_ms: 7_200_000 });
  });

  it("treats unparseable JSON output as intent='none' (no throw)", async () => {
    const callLlm = mock(() => Promise.resolve("this is not JSON"));
    const result = await classifyComment({
      commentBody: "@bot ship this",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "none" });
  });

  it("treats schema-invalid JSON output as intent='none'", async () => {
    const callLlm = mock(
      () => Promise.resolve(JSON.stringify({ intent: "deploy" })), // not in enum
    );
    const result = await classifyComment({
      commentBody: "@bot deploy this",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "none" });
  });

  it("treats LLM failure as intent='none' (resilient — does not throw)", async () => {
    const callLlm = mock(() => Promise.reject(new Error("bedrock 503")));
    const result = await classifyComment({
      commentBody: "@bot ship",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "none" });
  });

  // Regression: T042 surfaced that Anthropic Haiku 4.5 wraps single-object
  // responses in a markdown code fence even when told "Return ONLY a single
  // JSON object". Before the fix, this caused every NL trigger to
  // silently classify as `none` and fall through to the legacy intent
  // classifier, which routes ship to issues only — making
  // `@chrisleekr-bot-dev ship` on PRs silently no-op.
  it("unwraps a fenced ```json … ``` LLM response", async () => {
    const callLlm = mock(() => Promise.resolve('```json\n{ "intent": "ship" }\n```'));
    const result = await classifyComment({
      commentBody: "@bot ship",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "ship" });
  });

  it("unwraps a fenced ``` … ``` (no language tag) LLM response", async () => {
    const callLlm = mock(() => Promise.resolve('```\n{ "intent": "stop" }\n```'));
    const result = await classifyComment({
      commentBody: "@bot stop",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result).toEqual({ intent: "stop" });
  });
});

// `stripJsonFence` was lifted into `src/ai/structured-output.ts` and is
// covered by `test/ai/structured-output.test.ts` (fence-stripping cases).
// The classifier no longer exposes its own implementation.

describe("classifyComment — FR-029..FR-035 event-surface eligibility", () => {
  it("rewrites an ineligible intent to 'none' when eventSurface is provided", async () => {
    // bot:investigate is eligible on issue-comment / issue-label only.
    // On pr-comment, the post-classification gate rewrites it to 'none'.
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "investigate" })));
    const result = await classifyComment({
      commentBody: "@bot investigate this",
      triggerPhrase: "@bot",
      eventSurface: "pr-comment",
      callLlm,
    });
    expect(result).toEqual({ intent: "none" });
  });

  it("preserves an eligible intent when eventSurface matches", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "investigate" })));
    const result = await classifyComment({
      commentBody: "@bot investigate this",
      triggerPhrase: "@bot",
      eventSurface: "issue-comment",
      callLlm,
    });
    expect(result?.intent).toBe("investigate");
  });

  it("when eventSurface is not provided, no per-intent gating is applied (legacy callers)", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "investigate" })));
    const result = await classifyComment({
      commentBody: "@bot investigate this",
      triggerPhrase: "@bot",
      callLlm,
    });
    expect(result?.intent).toBe("investigate");
  });

  it("does NOT gate intent='none' regardless of surface (none is always pass-through)", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "none" })));
    const result = await classifyComment({
      commentBody: "@bot thanks",
      triggerPhrase: "@bot",
      eventSurface: "pr-comment",
      callLlm,
    });
    expect(result?.intent).toBe("none");
  });
});

describe("toCommandIntent", () => {
  it("returns the verb verbatim for non-'none' intents", () => {
    expect(toCommandIntent("ship")).toBe("ship");
    expect(toCommandIntent("stop")).toBe("stop");
    expect(toCommandIntent("investigate")).toBe("investigate");
  });

  it("returns null for intent='none'", () => {
    expect(toCommandIntent("none")).toBeNull();
  });
});
