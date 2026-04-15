import { describe, expect, it } from "bun:test";

import {
  DISPATCH_REASONS,
  DISPATCH_TARGETS,
  DispatchReasonSchema,
  DispatchTargetSchema,
  isDispatchReason,
  isDispatchTarget,
} from "../../src/shared/dispatch-types";

describe("DispatchTarget", () => {
  it("exposes exactly the four canonical targets in the documented order", () => {
    expect(DISPATCH_TARGETS).toEqual(["inline", "daemon", "shared-runner", "isolated-job"]);
  });

  it("Zod schema accepts every canonical value", () => {
    for (const target of DISPATCH_TARGETS) {
      const result = DispatchTargetSchema.safeParse(target);
      expect(result.success).toBe(true);
    }
  });

  it("Zod schema rejects 'auto' — auto is a mode, never a target", () => {
    const result = DispatchTargetSchema.safeParse("auto");
    expect(result.success).toBe(false);
  });

  it("Zod schema rejects legacy 'ephemeral-job' (renamed to 'isolated-job')", () => {
    const result = DispatchTargetSchema.safeParse("ephemeral-job");
    expect(result.success).toBe(false);
  });

  it("Zod schema rejects arbitrary strings and non-strings", () => {
    for (const bogus of ["", "nope", "INLINE", " shared-runner", 42, null, undefined, {}]) {
      const result = DispatchTargetSchema.safeParse(bogus);
      expect(result.success).toBe(false);
    }
  });

  it("isDispatchTarget returns true for every canonical value and false otherwise", () => {
    for (const target of DISPATCH_TARGETS) {
      expect(isDispatchTarget(target)).toBe(true);
    }
    for (const bogus of ["auto", "ephemeral-job", "", "INLINE", 42, null, undefined, {}, []]) {
      expect(isDispatchTarget(bogus)).toBe(false);
    }
  });

  it("isDispatchTarget narrows a string union at the type level", () => {
    const candidate: unknown = "shared-runner";
    if (isDispatchTarget(candidate)) {
      // TS: candidate is now DispatchTarget. This would fail to compile if
      // the guard did not narrow correctly.
      const canon: "inline" | "daemon" | "shared-runner" | "isolated-job" = candidate;
      expect(canon).toBe("shared-runner");
    } else {
      throw new Error("guard should have narrowed 'shared-runner' to DispatchTarget");
    }
  });
});

describe("DispatchReason", () => {
  it("exposes exactly the eight canonical reasons in the documented order", () => {
    expect(DISPATCH_REASONS).toEqual([
      "label",
      "keyword",
      "triage",
      "default-fallback",
      "triage-error-fallback",
      "static-default",
      "capacity-rejected",
      "infra-absent",
    ]);
  });

  it("Zod schema accepts every canonical value", () => {
    for (const reason of DISPATCH_REASONS) {
      const result = DispatchReasonSchema.safeParse(reason);
      expect(result.success).toBe(true);
    }
  });

  it("Zod schema rejects common near-miss typos", () => {
    for (const bogus of [
      "Label",
      "keywords",
      "triaged",
      "fallback",
      "default_fallback",
      "triage_error",
      "capacity_rejected",
      "capacity-rejection",
      "infraAbsent",
    ]) {
      const result = DispatchReasonSchema.safeParse(bogus);
      expect(result.success).toBe(false);
    }
  });

  it("isDispatchReason returns true for every canonical value and false otherwise", () => {
    for (const reason of DISPATCH_REASONS) {
      expect(isDispatchReason(reason)).toBe(true);
    }
    for (const bogus of ["auto", "", "Label", 42, null, undefined, {}, ["triage"]]) {
      expect(isDispatchReason(bogus)).toBe(false);
    }
  });
});
