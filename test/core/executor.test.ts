/**
 * Unit tests for executeAgent's cancellation surface.
 *
 * Covers issue #16: timeout/cancel must abort the SDK iterator (not just
 * reject a racing promise), and the wall-clock setTimeout must be cleared
 * on the happy path so the Bun test runner exits promptly.
 *
 * The Claude Agent SDK is replaced at module level so we can drive the
 * iterator from the test. mock.module persists for the Bun process: that
 * is acceptable here because no other test file imports the SDK directly
 * (only `src/core/executor.ts` does, and other suites mock executor itself).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { config } from "../../src/config";
import type { McpServerConfig } from "../../src/types";
import { makeBotContext } from "../factories";

interface QueryCall {
  options: {
    abortController?: AbortController;
    stderr?: (chunk: string) => void;
  };
}

let lastQueryCall: QueryCall | undefined;

/**
 * Async-iterable factory the mocked `query()` returns. Tests reassign this
 * before calling executeAgent. Default emits no messages (happy path).
 */
type IteratorFactory = () => AsyncIterableIterator<unknown>;

function emptyIterator(): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => Promise.resolve({ value: undefined, done: true }),
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

let nextIterator: IteratorFactory = emptyIterator;

void mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: mock(
    (opts: {
      prompt: string;
      options: { abortController?: AbortController; stderr?: (chunk: string) => void };
    }) => {
      lastQueryCall = { options: opts.options };
      return nextIterator();
    },
  ),
}));

const { executeAgent } = await import("../../src/core/executor");

const ORIGINAL_TIMEOUT = config.agentTimeoutMs;

function baseParams(
  extra: Partial<Parameters<typeof executeAgent>[0]> = {},
): Parameters<typeof executeAgent>[0] {
  return {
    ctx: makeBotContext(),
    prompt: "test prompt",
    mcpServers: {} as McpServerConfig,
    workDir: "/tmp/fake-workdir",
    allowedTools: [],
    ...extra,
  };
}

/** Build an iterator that resolves only when the SDK controller fires abort. */
function awaitAbortIterator(
  onAbort: (reason: unknown) => void = () => {},
): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      const controller = lastQueryCall?.options.abortController;
      if (controller === undefined) {
        return Promise.reject(new Error("controller missing from query options"));
      }
      return new Promise((_, reject) => {
        const fire = (): void => {
          const reason = controller.signal.reason;
          onAbort(reason);
          reject(reason instanceof Error ? reason : new Error("aborted"));
        };
        if (controller.signal.aborted) {
          fire();
        } else {
          controller.signal.addEventListener("abort", fire, { once: true });
        }
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

describe("executeAgent: cancellation", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  afterEach(() => {
    config.agentTimeoutMs = ORIGINAL_TIMEOUT;
  });

  it("forwards an AbortController into the SDK query options", async () => {
    await executeAgent(baseParams());

    expect(lastQueryCall).toBeDefined();
    expect(lastQueryCall?.options.abortController).toBeInstanceOf(AbortController);
  });

  it("aborts the SDK controller when the wall-clock timeout fires", async () => {
    config.agentTimeoutMs = 25;

    let observedReason: unknown;
    nextIterator = (): AsyncIterableIterator<unknown> =>
      awaitAbortIterator((reason) => {
        observedReason = reason;
      });

    const result = await executeAgent(baseParams());

    expect(result.success).toBe(false);
    expect(observedReason).toBeInstanceOf(Error);
    expect((observedReason as Error).message).toContain("timed out after 25ms");
    // Downstream handlers (workflow-executor → markFailed) read
    // result.errorMessage to populate state.failedReason on the
    // workflow_runs row. Asserting it explicitly here so the
    // operator-visibility contract from PR #90 cannot regress to
    // success: false with no message.
    expect(result.errorMessage).toMatch(/^Agent execution timed out after \d+ms$/);
  });

  it("clears the wall-clock timer on the happy path", async () => {
    config.agentTimeoutMs = 60_000;

    // Spy on setTimeout/clearTimeout so we can confirm the timer handle is
    // released, leaving it pending is what would otherwise pin the Bun
    // event loop for up to AGENT_TIMEOUT_MS after a successful run.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = mock(realSetTimeout);
    const clearSpy = mock(realClearTimeout);

    globalThis.setTimeout = setSpy as unknown as typeof setTimeout;

    globalThis.clearTimeout = clearSpy as unknown as typeof clearTimeout;
    try {
      await executeAgent(baseParams());
    } finally {
      // eslint-disable-next-line require-atomic-updates -- restore in finally
      globalThis.setTimeout = realSetTimeout;
      // eslint-disable-next-line require-atomic-updates -- restore in finally
      globalThis.clearTimeout = realClearTimeout;
    }

    const wallClockIdx = setSpy.mock.calls.findIndex((call) => call[1] === 60_000);
    expect(wallClockIdx).toBeGreaterThanOrEqual(0);
    const wallClockHandle = setSpy.mock.results[wallClockIdx]?.value;
    expect(wallClockHandle).toBeDefined();
    expect(clearSpy.mock.calls.some((call) => call[0] === wallClockHandle)).toBe(true);
  });

  it("propagates a caller-supplied aborted signal as a failed result", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by orchestrator"));

    nextIterator = () => awaitAbortIterator();

    const result = await executeAgent(baseParams({ signal: controller.signal }));

    expect(result.success).toBe(false);
    expect(lastQueryCall?.options.abortController?.signal.aborted).toBe(true);
    expect(result.errorMessage).toBe("cancelled by orchestrator");
  });

  it("propagates a caller signal aborted mid-execution", async () => {
    const controller = new AbortController();

    nextIterator = () => {
      // Fire the caller abort one microtask after the iterator starts, the
      // SDK controller must receive it via the listener wired in executeAgent.
      queueMicrotask(() => {
        controller.abort(new Error("daemon cancel"));
      });
      return awaitAbortIterator();
    };

    const result = await executeAgent(baseParams({ signal: controller.signal }));

    expect(result.success).toBe(false);
    expect(lastQueryCall?.options.abortController?.signal.aborted).toBe(true);
    expect(result.errorMessage).toBe("daemon cancel");
  });
});

describe("executeAgent: stderr callback", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("forwards a stderr callback into the SDK query options", async () => {
    await executeAgent(baseParams());

    expect(lastQueryCall?.options.stderr).toBeTypeOf("function");
  });

  it("logs non-empty stderr chunks at warn level on the request logger", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("oauth token expired\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]).toEqual([{ stderr: "oauth token expired" }, "Claude CLI stderr"]);
  });

  it("preserves leading indentation so multi-line stack traces stay readable", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("Error: boom\n    at foo (file.ts:1:1)\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn.mock.calls[0]?.[0]).toEqual({
      stderr: "Error: boom\n    at foo (file.ts:1:1)",
    });
  });

  it("skips whitespace-only chunks to avoid log spam", async () => {
    const params = baseParams();
    await executeAgent(params);

    lastQueryCall?.options.stderr?.("\n");
    lastQueryCall?.options.stderr?.("   \t\n");

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("caps stderr at 500 chars and flags truncation", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oversized = "x".repeat(600);
    lastQueryCall?.options.stderr?.(oversized);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [fields] = logWarn.mock.calls[0] ?? [];
    expect(fields).toEqual({ stderr: "x".repeat(500), truncated: true });
  });

  it("redacts secrets from stderr before logging and surfaces the kind", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oauth = `sk-ant-oat01-${"A".repeat(80)}`;
    lastQueryCall?.options.stderr?.(`auth failed: token=${oauth} expired`);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [fields] = logWarn.mock.calls[0] ?? [];
    expect(fields).toEqual({
      stderr: "auth failed: token= expired",
      redactedSecretCount: 1,
      redactedSecretKinds: ["ANTHROPIC_OAUTH"],
    });
  });

  it("skips chunks that become empty after secret redaction", async () => {
    const params = baseParams();
    await executeAgent(params);

    const oauthOnly = `sk-ant-oat01-${"A".repeat(80)}\n`;
    lastQueryCall?.options.stderr?.(oauthOnly);

    const logWarn = params.ctx.log.warn as ReturnType<typeof mock>;
    expect(logWarn).not.toHaveBeenCalled();
  });
});

// ─── prompt cache metrics (issue #134) ──────────────────────────────────────

/**
 * Build an iterator that yields a single fake SDKResultMessage with the
 * supplied usage fields, then terminates. The executor's completion log
 * reads result?.usage?.cache_read_input_tokens / cache_creation_input_tokens.
 */
function singleResultIterator(usage: {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): AsyncIterableIterator<unknown> {
  let emitted = false;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      if (emitted) {
        return Promise.resolve({ value: undefined, done: true });
      }
      emitted = true;
      return Promise.resolve({
        value: {
          type: "result",
          subtype: "success",
          duration_ms: 100,
          duration_api_ms: 50,
          is_error: false,
          num_turns: 3,
          result: "ok",
          stop_reason: "end_turn",
          total_cost_usd: 0.01,
          usage: {
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            ...usage,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "test-uuid",
          session_id: "test-session",
        },
        done: false,
      });
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  } as AsyncIterableIterator<unknown>;
}

describe("executeAgent: prompt cache metrics", () => {
  beforeEach(() => {
    lastQueryCall = undefined;
    nextIterator = emptyIterator;
  });

  it("logs cacheReadInputTokens and cacheCreationInputTokens from SDK usage", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      singleResultIterator({
        cache_read_input_tokens: 1234,
        cache_creation_input_tokens: 567,
      });

    const params = baseParams();
    const result = await executeAgent(params);

    expect(result.success).toBe(true);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    // Find the "Claude Agent SDK execution completed" call so we can assert
    // on its structured fields. Earlier info() calls in the executor log
    // unrelated diagnostics ("Starting...", per-message events).
    const completion = logInfo.mock.calls.find(
      (call) => call[1] === "Claude Agent SDK execution completed",
    );
    expect(completion).toBeDefined();
    const fields = (completion as [Record<string, unknown>, string])[0];
    expect(fields.cacheReadInputTokens).toBe(1234);
    expect(fields.cacheCreationInputTokens).toBe(567);
    expect(fields.success).toBe(true);
  });

  it("logs zero cache tokens when the SDK reports a cold cache", async () => {
    nextIterator = (): AsyncIterableIterator<unknown> =>
      singleResultIterator({ cache_read_input_tokens: 0, cache_creation_input_tokens: 8192 });

    const params = baseParams();
    await executeAgent(params);

    const logInfo = params.ctx.log.info as ReturnType<typeof mock>;
    const completion = logInfo.mock.calls.find(
      (call) => call[1] === "Claude Agent SDK execution completed",
    );
    const fields = (completion as [Record<string, unknown>, string])[0];
    expect(fields.cacheReadInputTokens).toBe(0);
    expect(fields.cacheCreationInputTokens).toBe(8192);
  });
});
