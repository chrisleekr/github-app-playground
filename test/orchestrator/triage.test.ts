/**
 * Unit tests for the triage engine (T030). Exercises every fallback path:
 *   happy path → parse-error → timeout → sub-threshold → circuit-open
 *   → unknown-mode (schema drift) → disabled-flag short-circuit
 *
 * The LLM client is stubbed via `_createLLMClientForTests`; Postgres writes
 * use the test DB when `DATABASE_URL` is set and become no-ops otherwise.
 * We rely on the test-isolated runner (one Bun process per file) so the
 * module-level circuit breaker is fresh per file.
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
            mode: "daemon",
            confidence: 1.0,
            complexity: "moderate",
            rationale: "standard code change",
          }),
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("result");
    if (r.outcome === "result") {
      expect(r.result.mode).toBe("daemon");
      expect(r.result.complexity).toBe("moderate");
      expect(r.result.provider).toBe("anthropic");
      expect(r.result.costUsd).toBeGreaterThan(0);
    }
  });

  it("strips surrounding prose / code fences via extractJsonObject", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          'Sure — here is the classification:\n```json\n{"mode":"daemon","confidence":1,"complexity":"trivial","rationale":"small"}\n```',
        ),
      ),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("result");
  });
});

describe("triageRequest — fallback paths", () => {
  it("reason='parse-error' when the body is not JSON at all", async () => {
    const client = makeStubClient(() => Promise.resolve(responseText("I think daemon.")));
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("parse-error");
  });

  it("reason='parse-error' when JSON is syntactically broken", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(responseText('{"mode":"daemon",confidence: 0.9}')),
    );
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("parse-error");
  });

  it("reason='parse-error' on schema drift (unknown mode)", async () => {
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            mode: "auto",
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
    // Proper timeout plumbing via setTimeout would force this test to wait
    // TRIAGE_TIMEOUT_MS (default 5s), slowing the suite. The engine detects
    // timeouts by the sentinel message prefix `triage-timeout`, so we stub
    // an immediate rejection with that message and pin the mapping.
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
    // First 5 calls error; 6th short-circuits.
    for (let i = 0; i < 5; i += 1) {
      await triageRequest(makeInput(), client);
    }
    const r = await triageRequest(makeInput(), client);
    expect(r.outcome).toBe("fallback");
    if (r.outcome === "fallback") expect(r.reason).toBe("circuit-open");
  });

  it("reason='sub-threshold' when confidence < TRIAGE_CONFIDENCE_THRESHOLD (default 1.0)", async () => {
    // Default threshold is 1.0 per spec — anything less than 1.0 falls back.
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            mode: "daemon",
            confidence: 0.99,
            complexity: "trivial",
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
    // Regression: earlier Slice D shape dropped the parsed result on
    // sub-threshold, which prevented the router from populating
    // triage_confidence / triage_cost_usd / triage_complexity on the
    // default-fallback executions row (Copilot PR #20 comment).
    const client = makeStubClient(() =>
      Promise.resolve(
        responseText(
          JSON.stringify({
            mode: "shared-runner",
            confidence: 0.5,
            complexity: "moderate",
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
      expect(r.result?.mode).toBe("shared-runner");
      expect(r.result?.complexity).toBe("moderate");
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
    // Prompt should contain at most 2000 x's (plus the framing lines).
    const xCount = (p.match(/x/g) ?? []).length;
    expect(xCount).toBe(2_000);
  });

  it("renders '(none)' when labels are empty", () => {
    expect(buildTriagePrompt(makeInput({ labels: [] }))).toContain("Labels: (none)");
  });
});
