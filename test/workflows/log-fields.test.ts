import { describe, expect, it } from "bun:test";

import {
  WORKFLOW_RUN_LOG_EVENTS,
  WorkflowRunLogFieldsSchema,
} from "../../src/workflows/log-fields";

const target = { type: "pr" as const, owner: "o", repo: "r", number: 7 };

describe("WORKFLOW_RUN_LOG_EVENTS", () => {
  it("pins the eight canonical event strings", () => {
    expect(WORKFLOW_RUN_LOG_EVENTS.queued).toBe("workflow.run.queued");
    expect(WORKFLOW_RUN_LOG_EVENTS.running).toBe("workflow.run.running");
    expect(WORKFLOW_RUN_LOG_EVENTS.succeeded).toBe("workflow.run.succeeded");
    expect(WORKFLOW_RUN_LOG_EVENTS.failed).toBe("workflow.run.failed");
    expect(WORKFLOW_RUN_LOG_EVENTS.incomplete).toBe("workflow.run.incomplete");
    expect(WORKFLOW_RUN_LOG_EVENTS.handedOff).toBe("workflow.run.handed_off");
    expect(WORKFLOW_RUN_LOG_EVENTS.dispatchRefused).toBe("workflow.run.dispatch_refused");
    expect(WORKFLOW_RUN_LOG_EVENTS.enqueueFailed).toBe("workflow.run.enqueue_failed");
  });
});

describe("WorkflowRunLogFieldsSchema: accepts well-formed events", () => {
  it("accepts queued with and without deliveryId", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.queued,
        runId: "run-1",
        workflowName: "review",
        target,
        deliveryId: "d1",
      }).success,
    ).toBe(true);
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.queued,
        runId: "run-1",
        workflowName: "review",
        target,
      }).success,
    ).toBe(true);
  });

  it("accepts running", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.running,
        runId: "run-1",
        workflowName: "implement",
        target,
        deliveryId: "d1",
      }).success,
    ).toBe(true);
  });

  it("accepts succeeded with duration_ms", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.succeeded,
        runId: "run-1",
        workflowName: "plan",
        target,
        deliveryId: "d1",
        duration_ms: 1234,
      }).success,
    ).toBe(true);
  });

  it("accepts incomplete with reason", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.incomplete,
        runId: "run-1",
        workflowName: "resolve",
        target,
        duration_ms: 9,
        reason: "ci still red",
      }).success,
    ).toBe(true);
  });

  it("accepts failed with reason", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.failed,
        runId: "run-1",
        workflowName: "implement",
        target,
        duration_ms: 9,
        reason: "uncaught: boom",
      }).success,
    ).toBe(true);
  });

  it("accepts handed_off with childRunId", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.handedOff,
        runId: "run-1",
        workflowName: "ship",
        target,
        duration_ms: 9,
        childRunId: "child-1",
      }).success,
    ).toBe(true);
  });

  it("accepts dispatch_refused without runId", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.dispatchRefused,
        workflowName: "review",
        target,
        reason: "in-flight",
      }).success,
    ).toBe(true);
  });

  it("accepts enqueue_failed with runId and reason", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.enqueueFailed,
        runId: "run-1",
        workflowName: "review",
        target,
        reason: "enqueue failed: ECONNREFUSED",
      }).success,
    ).toBe(true);
  });
});

describe("WorkflowRunLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects an unknown event literal", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: "workflow.run.bogus",
        runId: "run-1",
        workflowName: "review",
        target,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown extra field (strict)", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.queued,
        runId: "run-1",
        workflowName: "review",
        target,
        surprise: "boo",
      }).success,
    ).toBe(false);
  });

  it("rejects succeeded missing duration_ms", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.succeeded,
        runId: "run-1",
        workflowName: "plan",
        target,
      }).success,
    ).toBe(false);
  });

  it("rejects camelCase durationMs (must be snake_case)", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.succeeded,
        runId: "run-1",
        workflowName: "plan",
        target,
        durationMs: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects failed missing reason", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.failed,
        runId: "run-1",
        workflowName: "implement",
        target,
        duration_ms: 9,
      }).success,
    ).toBe(false);
  });

  it("rejects dispatch_refused carrying a runId (no row exists yet)", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.dispatchRefused,
        runId: "run-1",
        workflowName: "review",
        target,
        reason: "in-flight",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed target (number must be positive int)", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.queued,
        runId: "run-1",
        workflowName: "review",
        target: { type: "pr", owner: "o", repo: "r", number: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects an empty runId", () => {
    expect(
      WorkflowRunLogFieldsSchema.safeParse({
        event: WORKFLOW_RUN_LOG_EVENTS.running,
        runId: "",
        workflowName: "review",
        target,
      }).success,
    ).toBe(false);
  });
});
