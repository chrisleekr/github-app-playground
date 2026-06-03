import { describe, expect, it } from "bun:test";

import {
  CORE_PIPELINE_LOG_EVENTS,
  PipelineCompletedLogSchema,
  PipelineStageLogSchema,
} from "../../src/core/log-fields";

describe("PipelineCompletedLogSchema (#192)", () => {
  it("accepts a full pipeline.completed line carrying token counters", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      durationMs: 4200,
      costUsd: 0.012,
      numTurns: 3,
      inputTokens: 1500,
      outputTokens: 220,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 0,
      pipeline_wall_clock_ms: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimal line (optional metrics omitted, e.g. dry-run)", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown / misnamed token field (strict shape pins drift)", () => {
    const result = PipelineCompletedLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
      input_tokens: 1500, // snake_case typo, the field is inputTokens
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative / non-integer token counter", () => {
    const base = {
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      success: true,
      pipeline_wall_clock_ms: 12,
    };
    expect(PipelineCompletedLogSchema.safeParse({ ...base, inputTokens: -1 }).success).toBe(false);
    expect(PipelineCompletedLogSchema.safeParse({ ...base, outputTokens: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("PipelineStageLogSchema (#166)", () => {
  it("accepts a well-formed pipeline.stage line", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.stage,
      stage: "github.fetch",
      delta_ms: 1234,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field (strict shape pins drift)", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.stage,
      stage: "github.fetch",
      delta_ms: 1234,
      durationMs: 1234, // wrong field name, must be rejected
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer / negative delta_ms", () => {
    expect(
      PipelineStageLogSchema.safeParse({
        event: CORE_PIPELINE_LOG_EVENTS.stage,
        stage: "x",
        delta_ms: 1.5,
      }).success,
    ).toBe(false);
    expect(
      PipelineStageLogSchema.safeParse({
        event: CORE_PIPELINE_LOG_EVENTS.stage,
        stage: "x",
        delta_ms: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects the wrong event literal", () => {
    const result = PipelineStageLogSchema.safeParse({
      event: CORE_PIPELINE_LOG_EVENTS.completed,
      stage: "x",
      delta_ms: 1,
    });
    expect(result.success).toBe(false);
  });

  it("exposes the four canonical event keys", () => {
    expect(CORE_PIPELINE_LOG_EVENTS).toEqual({
      started: "pipeline.started",
      stage: "pipeline.stage",
      completed: "pipeline.completed",
      failed: "pipeline.failed",
    });
  });
});
