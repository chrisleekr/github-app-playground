import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  parseStructuredResponse,
  stripJsonFence,
  STRUCTURED_OUTPUT_RULES,
  withStructuredRules,
} from "../../src/ai/structured-output";

const ChatSchema = z.object({
  mode: z.literal("answer"),
  reply: z.string().min(1),
});

describe("withStructuredRules", () => {
  it("appends the rules block to a caller's system prompt", () => {
    const result = withStructuredRules("You are a classifier.");
    expect(result.startsWith("You are a classifier.")).toBe(true);
    expect(result).toContain(STRUCTURED_OUTPUT_RULES);
  });

  it("is idempotent — does not double-append on repeated calls", () => {
    const once = withStructuredRules("You are a classifier.");
    const twice = withStructuredRules(once);
    expect(twice).toBe(once);
  });

  it("trims trailing whitespace from caller prompt before appending", () => {
    const result = withStructuredRules("You are a classifier.\n\n");
    expect(result).toBe(`You are a classifier.\n\n${STRUCTURED_OUTPUT_RULES}`);
  });
});

describe("stripJsonFence", () => {
  it("strips ```json ... ``` fences", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` ... ``` fences", () => {
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("passes unfenced JSON through unchanged", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });

  it("does not strip a half-open fence (only leading)", () => {
    const half = '```json\n{"a":1}';
    expect(stripJsonFence(half)).toBe(half);
  });
});

describe("parseStructuredResponse", () => {
  it("returns ok:true with strategy='strict' for idiomatic valid JSON", () => {
    const raw = '{"mode":"answer","reply":"hi"}';
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe("strict");
      expect(result.data).toEqual({ mode: "answer", reply: "hi" });
      expect(result.raw).toBe(raw);
    }
  });

  it("returns ok:true with strategy='tolerant' when raw newlines are present in string values", () => {
    const broken = '{\n  "mode": "answer",\n  "reply": "line1\nline2"\n}';
    const result = parseStructuredResponse(broken, ChatSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe("tolerant");
      expect(result.data).toEqual({ mode: "answer", reply: "line1\nline2" });
    }
  });

  it("strips a markdown code fence before parsing", () => {
    const raw = '```json\n{"mode":"answer","reply":"hi"}\n```';
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.reply).toBe("hi");
  });

  it("returns ok:false stage='parse' on truly malformed JSON", () => {
    const raw = '{"mode":"answer","reply":';
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("parse");
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.raw).toBe(raw);
    }
  });

  it("returns ok:false stage='validate' when JSON parses but schema rejects", () => {
    const raw = '{"mode":"unknown","reply":"hi"}';
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("validate");
      // `parsed` field should carry the raw object so callers can log it.
      if (result.stage === "validate") {
        expect(result.parsed).toEqual({ mode: "unknown", reply: "hi" });
      }
    }
  });

  it("returns ok:false stage='validate' when required fields are missing", () => {
    const raw = '{"mode":"answer"}';
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("validate");
  });

  it("recovers a real-world chat-thread shape (multi-line markdown reply)", () => {
    const raw = `{
  "mode": "answer",
  "reply": "_💡 Explanation_

**The chat-thread executor is a thing.**

1. It does a thing.
2. It does another thing."
}`;
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.strategy).toBe("tolerant");
      expect(result.data.reply).toContain("**The chat-thread executor is a thing.**");
      expect(result.data.reply).toContain("1. It does a thing.");
    }
  });

  it("preserves raw output on failure for caller-side logging", () => {
    const raw = "definitely not json";
    const result = parseStructuredResponse(raw, ChatSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe(raw);
  });
});
