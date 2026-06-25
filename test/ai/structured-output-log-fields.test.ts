import { describe, expect, it } from "bun:test";

import {
  STRUCTURED_OUTPUT_EVENTS,
  StructuredOutputLogFieldsSchema,
} from "../../src/ai/structured-output-log-fields";

describe("STRUCTURED_OUTPUT_EVENTS", () => {
  it("pins the three canonical event strings", () => {
    expect(STRUCTURED_OUTPUT_EVENTS.parsed).toBe("structured_output.parsed");
    expect(STRUCTURED_OUTPUT_EVENTS.parseFailed).toBe("structured_output.parse_failed");
    expect(STRUCTURED_OUTPUT_EVENTS.validateFailed).toBe("structured_output.validate_failed");
  });
});

describe("StructuredOutputLogFieldsSchema: accepts well-formed events", () => {
  it("accepts a structured_output.parsed record with strict strategy", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "chat-thread",
      raw_len: 128,
      parse_ms: 2,
      strategy: "strict",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a structured_output.parsed record with tolerant strategy", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "triage-orchestrator",
      raw_len: 0,
      parse_ms: 0,
      strategy: "tolerant",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a structured_output.parse_failed record", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parseFailed,
      site: "discussion-digest",
      raw_len: 42,
      parse_ms: 1,
      error: "Unexpected token } in JSON at position 5",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a structured_output.validate_failed record", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.validateFailed,
      site: "nl-classifier",
      raw_len: 64,
      parse_ms: 3,
      error: "Required",
      parsed_kind: "array",
    });
    expect(result.success).toBe(true);
  });
});

describe("StructuredOutputLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown extra field (strict)", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "chat-thread",
      raw_len: 1,
      parse_ms: 1,
      strategy: "strict",
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: "structured_output.bogus",
      site: "chat-thread",
      raw_len: 1,
      parse_ms: 1,
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid strategy enum on parsed", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "chat-thread",
      raw_len: 1,
      parse_ms: 1,
      strategy: "fuzzy",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid parsed_kind enum on validate_failed", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.validateFailed,
      site: "nl-classifier",
      raw_len: 1,
      parse_ms: 1,
      error: "Required",
      parsed_kind: "scalar",
    });
    expect(result.success).toBe(false);
  });

  it("rejects strategy on a parse_failed event (wrong field presence)", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parseFailed,
      site: "discussion-digest",
      raw_len: 1,
      parse_ms: 1,
      error: "boom",
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a parsed record missing strategy", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "chat-thread",
      raw_len: 1,
      parse_ms: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a validate_failed record missing parsed_kind", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.validateFailed,
      site: "nl-classifier",
      raw_len: 1,
      parse_ms: 1,
      error: "Required",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty site", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "",
      raw_len: 1,
      parse_ms: 1,
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative parse_ms", () => {
    const result = StructuredOutputLogFieldsSchema.safeParse({
      event: STRUCTURED_OUTPUT_EVENTS.parsed,
      site: "chat-thread",
      raw_len: 1,
      parse_ms: -1,
      strategy: "strict",
    });
    expect(result.success).toBe(false);
  });
});
