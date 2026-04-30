/**
 * Tests for the meta-issue classifier helper used by `bot:open-pr`
 * (T079 / FR-035). ≥90% coverage on
 * `src/workflows/ship/scoped/meta-issue-classifier.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { classifyMetaIssue } from "../../../../src/workflows/ship/scoped/meta-issue-classifier";
import { expectToReject } from "../../../utils/assertions";

describe("classifyMetaIssue", () => {
  it("returns the validated verdict on a well-formed bug response", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "bug", reason: "concrete crash" })),
    );
    const v = await classifyMetaIssue({
      title: "Crash",
      body: "stack trace",
      callLlm,
    });
    expect(v.actionable).toBe(true);
    expect(v.kind).toBe("bug");
  });

  it("enforces actionable=true only for kind=bug or kind=feature even if LLM lies", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "tracking", reason: "x" })),
    );
    const v = await classifyMetaIssue({ title: "T", body: "", callLlm });
    expect(v.actionable).toBe(false);
    expect(v.kind).toBe("tracking");
  });

  it("preserves actionable=false for legitimate non-actionable kinds", async () => {
    const callLlm = mock(() =>
      Promise.resolve(
        JSON.stringify({ actionable: false, kind: "discussion", reason: "open-ended" }),
      ),
    );
    const v = await classifyMetaIssue({ title: "T", body: "", callLlm });
    expect(v.actionable).toBe(false);
    expect(v.kind).toBe("discussion");
  });

  it("throws on non-JSON output", async () => {
    const callLlm = mock(() => Promise.resolve("not json at all"));
    await expectToReject(classifyMetaIssue({ title: "T", body: "", callLlm }), "non-JSON");
  });

  it("throws on schema-invalid JSON", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: "yes", kind: "wat", reason: 42 })),
    );
    await expectToReject(classifyMetaIssue({ title: "T", body: "", callLlm }), "schema");
  });

  it("throws on schema-valid JSON with empty reason", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "bug", reason: "" })),
    );
    await expectToReject(classifyMetaIssue({ title: "T", body: "", callLlm }), "schema");
  });

  it("forwards title and body to the LLM prompt verbatim", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "feature", reason: "ok" })),
    );
    await classifyMetaIssue({
      title: "Add darkmode",
      body: "Users want a darkmode toggle.",
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("Add darkmode");
    expect(userPrompt).toContain("Users want a darkmode toggle.");
  });
});
