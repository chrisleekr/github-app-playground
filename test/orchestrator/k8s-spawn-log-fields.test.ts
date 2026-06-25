import { describe, expect, it } from "bun:test";

import {
  K8S_SPAWN_LOG_EVENTS,
  K8sSpawnLogFieldsSchema,
} from "../../src/orchestrator/k8s-spawn-log-fields";

describe("K8S_SPAWN_LOG_EVENTS", () => {
  it("pins the four canonical event strings", () => {
    expect(K8S_SPAWN_LOG_EVENTS.decisionSkipped).toBe("k8s.spawn.decision_skipped");
    expect(K8S_SPAWN_LOG_EVENTS.attempted).toBe("k8s.spawn.attempted");
    expect(K8S_SPAWN_LOG_EVENTS.succeeded).toBe("k8s.spawn.succeeded");
    expect(K8S_SPAWN_LOG_EVENTS.failed).toBe("k8s.spawn.failed");
  });
});

describe("K8sSpawnLogFieldsSchema: accepts well-formed events", () => {
  it("accepts decision_skipped with reason no-signal", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.decisionSkipped,
      delivery_id: "d1",
      reason: "no-signal",
      heavy: false,
      queue_length: 0,
      persistent_free_slots: 5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts decision_skipped with reason cooldown and negative free slots", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.decisionSkipped,
      delivery_id: "d1",
      reason: "cooldown",
      heavy: true,
      queue_length: 3,
      persistent_free_slots: -1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts attempted with a trigger", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.attempted,
      delivery_id: "d1",
      trigger: "triage-heavy",
    });
    expect(result.success).toBe(true);
  });

  it("accepts succeeded with pod_name, namespace, api_call_ms", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.succeeded,
      delivery_id: "d1",
      trigger: "queue-overflow",
      pod_name: "ephemeral-daemon-d1-abc",
      namespace: "default",
      api_call_ms: 142,
    });
    expect(result.success).toBe(true);
  });

  it("accepts failed with kind + api_call_ms (api path)", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.failed,
      delivery_id: "d1",
      kind: "api-rejected",
      trigger: "triage-heavy",
      api_call_ms: 87,
    });
    expect(result.success).toBe(true);
  });

  it("accepts failed without api_call_ms (load-failure path)", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.failed,
      delivery_id: "d1",
      kind: "infra-absent",
    });
    expect(result.success).toBe(true);
  });
});

describe("K8sSpawnLogFieldsSchema: rejects drift and bad input", () => {
  it("rejects camelCase api_call_ms drift on succeeded", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.succeeded,
      delivery_id: "d1",
      trigger: "triage-heavy",
      pod_name: "p",
      namespace: "default",
      apiCallMs: 10,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown extra field (strict)", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.attempted,
      delivery_id: "d1",
      trigger: "triage-heavy",
      surprise: "boo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown event literal", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: "k8s.spawn.bogus",
      delivery_id: "d1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative api_call_ms", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.succeeded,
      delivery_id: "d1",
      trigger: "triage-heavy",
      pod_name: "p",
      namespace: "default",
      api_call_ms: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer api_call_ms", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.failed,
      delivery_id: "d1",
      kind: "api-unavailable",
      api_call_ms: 12.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown EphemeralSpawnErrorKind", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.failed,
      delivery_id: "d1",
      kind: "disk-full",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid reason on decision_skipped", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.decisionSkipped,
      delivery_id: "d1",
      reason: "whatever",
      heavy: false,
      queue_length: 0,
      persistent_free_slots: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid trigger on attempted", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.attempted,
      delivery_id: "d1",
      trigger: "manual",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty delivery_id", () => {
    const result = K8sSpawnLogFieldsSchema.safeParse({
      event: K8S_SPAWN_LOG_EVENTS.attempted,
      delivery_id: "",
      trigger: "triage-heavy",
    });
    expect(result.success).toBe(false);
  });
});
