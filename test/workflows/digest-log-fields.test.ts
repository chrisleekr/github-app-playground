import { describe, expect, it } from "bun:test";

import { DIGEST_LOG_EVENTS, DigestLogFieldsSchema } from "../../src/workflows/digest-log-fields";

describe("DIGEST_LOG_EVENTS", () => {
  it("pins the four canonical event strings", () => {
    expect(DIGEST_LOG_EVENTS.skipped).toBe("digest.skipped");
    expect(DIGEST_LOG_EVENTS.callCompleted).toBe("digest.call.completed");
    expect(DIGEST_LOG_EVENTS.completed).toBe("digest.completed");
    expect(DIGEST_LOG_EVENTS.failed).toBe("digest.failed");
  });
});

describe("DigestLogFieldsSchema: accepts well-formed events", () => {
  it("accepts a valid digest.skipped record", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.skipped,
      comment_counts: { owner: 0, other: 0, bot: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid digest.call.completed record (extract, strict)", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.callCompleted,
      phase: "extract",
      input_tokens: 1200,
      output_tokens: 340,
      latency_ms: 850,
      strategy: "strict",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid digest.call.completed record (reduce, tolerant)", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.callCompleted,
      phase: "reduce",
      input_tokens: 500,
      output_tokens: 200,
      latency_ms: 600,
      strategy: "tolerant",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid digest.completed record", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.completed,
      chunks: 1,
      total_latency_ms: 900,
      directives_kept: 2,
      directives_dropped: 0,
      has_prior_bot_output: true,
      untrusted_context_count: 3,
      conversation_summary_chars: 412,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid digest.failed record for each reason", () => {
    for (const reason of ["no-comments", "llm-error", "parse-error"] as const) {
      const result = DigestLogFieldsSchema.safeParse({
        event: DIGEST_LOG_EVENTS.failed,
        reason,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe("DigestLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.completed,
      chunks: 1,
      total_latency_ms: 900,
      directives_kept: 2,
      directives_dropped: 0,
      has_prior_bot_output: true,
      untrusted_context_count: 3,
      conversation_summary_chars: 412,
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown extra field on nested comment_counts (strict)", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.skipped,
      comment_counts: { owner: 0, other: 0, bot: 3, ghost: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: "digest.bogus",
      reason: "llm-error",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid phase on digest.call.completed", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.callCompleted,
      phase: "merge",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid strategy on digest.call.completed", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.callCompleted,
      phase: "extract",
      input_tokens: 1,
      output_tokens: 1,
      latency_ms: 1,
      strategy: "lenient",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reason on digest.failed", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.failed,
      reason: "weird",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a digest.completed record with chunks below 1", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.completed,
      chunks: 0,
      total_latency_ms: 900,
      directives_kept: 0,
      directives_dropped: 0,
      has_prior_bot_output: false,
      untrusted_context_count: 0,
      conversation_summary_chars: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative numeric metric", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.callCompleted,
      phase: "extract",
      input_tokens: -1,
      output_tokens: 1,
      latency_ms: 1,
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fields-on-wrong-event mix (reason on completed)", () => {
    const result = DigestLogFieldsSchema.safeParse({
      event: DIGEST_LOG_EVENTS.completed,
      reason: "llm-error",
    });
    expect(result.success).toBe(false);
  });
});
