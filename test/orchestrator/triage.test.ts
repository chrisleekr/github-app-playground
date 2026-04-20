/**
 * Unit tests for the post-collapse triage engine. The LLM client is stubbed
 * via `_createLLMClientForTests`; Postgres writes use the test DB when
 * `DATABASE_URL` is set and become no-ops otherwise. Per-file test isolation
 * means the module-level circuit breaker is fresh per run.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import {
  _createLLMClientForTests,
  type AnthropicLikeSdk,
  type AnthropicMessageResponse,
  type LLMClient,
} from "../../src/ai/llm-client";
import {
  _resetTriageBreakerForTests,
  buildTriagePrompt,
  extractJsonObject,
  type TriageInput,
  triageRequest,
} from "../../src/orchestrator/triage";

function makeInput(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    owner: "o",
    repo: "r",
    eventName: "issue_comment",
    isPR: false,
    labels: [],
    triggerBody: "please look at this",
    ...overrides,
  };
}

function makeStubClient(responder: (req: unknown) => Promise<AnthropicMessageResponse>): LLMClient {
  const sdk: AnthropicLikeSdk = {
    messages: { create: (req) => responder(req) },
  };
  return _createLLMClientForTests("anthropic", sdk);
}

function responseText(text: string): AnthropicMessageResponse {
  return {
    content: [{ type: "text", text }],
    model: "claude-3-5-haiku-20241022",
    usage: { input_tokens: 50, output_tokens: 30 },
  };
}

beforeEach(() => {
  _resetTriageBreakerForTests();
});

describe("triageRequest — happy path", () => {
  it("returns { outcome: 'result' } on a well-formed JSON response above threshold", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            heavy: true,
            confidence: 1.0,
            rationale: "touches migrations and many services",
          }),
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("result");
    if (r.outcome === "result") {
      expect(r.result.heavy).toBe(true);
      expect(r.result.confidence).toBe(1);
      expect(r.result.provider).toBe("anthropic");
      expect(r.result.costUsd).toBeGreaterThan(0);
    }
  });

  it("accepts heavy=false responses above threshold", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(JSON.stringify({ heavy: false, confidence: 1.0, rationale: "small tweak" })),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("result");
    if (r.outcome === "result") {
      expect(r.result.heavy).toBe(false);
    }
  });

  it("strips surrounding prose / code fences via extractJsonObject", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          'Sure — here is the classification:\n```json\n{"heavy":false,"confidence":1,"rationale":"tiny"}\n```',
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("result");
  });
});

describe("triageRequest — fallback paths", () => {
  it("reason='parse-error' when the body is not JSON at all", async () => {
    const client = makeStubClient(() => Promise.resolve(responseText("I think heavy.")));
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("parse-error");
  });

  it("reason='parse-error' when JSON is syntactically broken", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(responseText('{"heavy":true,confidence: 0.9}')),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("parse-error");
  });

  it("reason='parse-error' on schema drift (legacy mode/complexity shape)", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            mode: "daemon",
            confidence: 0.9,
            complexity: "moderate",
            rationale: "x",
          }),
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("parse-error");
  });

  it("reason='timeout' when the LLM call surfaces the timeout sentinel", async () => {
    const client = makeStubClient(() => Promise.reject(new Error("triage-timeout after 5000ms")));
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("timeout");
  });

  it("reason='llm-error' on a non-timeout SDK rejection", async () => {
    const client = makeStubClient(() => Promise.reject(new Error("500 Internal Server Error")));
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("llm-error");
  });

  it("reason='circuit-open' after 5 consecutive failures", async () => {
    const client = makeStubClient(() => Promise.reject(new Error("boom")));
    for (let i = 0; i < 5; i += 1) {
      await triageRequest(makeInput(), client);
    }
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("circuit-open");
  });

  it("reason='sub-threshold' when confidence < TRIAGE_CONFIDENCE_THRESHOLD (default 1.0)", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            heavy: true,
            confidence: 0.99,
            rationale: "close but not confident",
          }),
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("sub-threshold");
  });

  it("sub-threshold fallback carries the parsed TriageResult for downstream telemetry", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            heavy: true,
            confidence: 0.5,
            rationale: "uncertain",
          }),
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") {
      expect(r.reason).toBe("sub-threshold");
      expect(r.result).toBeDefined();
      expect(r.result?.heavy).toBe(true);
      expect(r.result?.confidence).toBe(0.5);
    }
  });

  it("parse-error and llm-error fallbacks do NOT carry a result", async () => {
    const parseErr = makeStubClient(() => Promise.resolve(responseText("not json at all")));
    const r1 = await triageRequest(makeInput(), parseErr);
    expect(r1.outcome).toBe("fallback");
    if (r1.outcome === "fallback") {
      expect(r1.reason).toBe("parse-error");
      expect(r1.result).toBeUndefined();
    }

    const llmErr = makeStubClient(() => Promise.reject(new Error("boom")));
    const r2 = await triageRequest(makeInput(), llmErr);
    expect(r2.outcome).toBe("fallback");
    if (r2.outcome === "fallback") {
      expect(r2.reason).toBe("llm-error");
      expect(r2.result).toBeUndefined();
    }
  });
});

describe("extractJsonObject", () => {
  it("returns a trimmed JSON string unchanged", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("extracts from code-fenced wrapping", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("extracts the first top-level object when prose precedes it", () => {
    expect(extractJsonObject('Here you go: {"a":1} — done')).toBe('{"a":1}');
  });

  it("returns null when no braces are present", () => {
    expect(extractJsonObject("just prose")).toBeNull();
  });

  it("returns null when braces are in the wrong order", () => {
    expect(extractJsonObject("} something {")).toBeNull();
  });
});

describe("buildTriagePrompt", () => {
  it("formats repo, event, and labels", () => {
    const p = buildTriagePrompt(
      makeInput({
        owner: "chrisleekr",
        repo: "app",
        eventName: "issues",
        isPR: false,
        labels: ["bug", "triage"],
        triggerBody: "crash on startup",
      }),
    );
    expect(p).toContain("chrisleekr/app");
    expect(p).toContain("Event: issues on issue");
    expect(p).toContain("Labels: bug, triage");
    expect(p).toContain("crash on startup");
  });

  it("clips very long trigger bodies to 2000 chars", () => {
    const p = buildTriagePrompt(makeInput({ triggerBody: "x".repeat(3_000) }));
    const xCount = (p.match(/x/g) ?? []).length;
    expect(xCount).toBe(2_000);
  });

  it("renders '(none)' when labels are empty", () => {
    expect(buildTriagePrompt(makeInput({ labels: [] }))).toContain("Labels: (none)");
  });
});
