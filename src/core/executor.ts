import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../config";
import type { BotContext, ExecutionResult, McpServerConfig } from "../types";

function isResultMessage(msg: unknown): msg is SDKResultMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as { type: unknown }).type === "result"
  );
}

/**
 * Build the subprocess environment for the Claude Code CLI.
 *
 * Spreads the current process.env so all inherited variables (AWS_PROFILE,
 * AWS_WEB_IDENTITY_TOKEN_FILE for IRSA, etc.) flow through automatically.
 * For Bedrock, injects CLAUDE_CODE_USE_BEDROCK=1 which the CLI binary reads
 * to switch from the Anthropic API to the Bedrock runtime endpoint.
 * We avoid mutating process.env directly so the main process stays unaffected.
 *
 * Anthropic credentials (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, etc.) are
 * forwarded as part of the `...process.env` spread — no explicit handling here.
 * The Claude CLI subprocess picks between them via its own documented auth
 * precedence chain (API key at position 3 beats OAuth token at position 5).
 * See https://code.claude.com/docs/en/authentication#authentication-precedence
 *
 * When `installationToken` is supplied, it is exported as both `GH_TOKEN` and
 * `GITHUB_TOKEN` so the agent's shell `gh`/`git` calls authenticate as the
 * GitHub App installation. MCP servers receive the same token via their own
 * env mapping in `src/mcp/registry.ts`.
 */
export function buildProviderEnv(
  installationToken?: string,
  artifactsDir?: string,
): Record<string, string | undefined> {
  // Strip empty credential env vars before forwarding to the CLI. The CLI's
  // documented auth precedence chain (ANTHROPIC_API_KEY at position 3 beats
  // CLAUDE_CODE_OAUTH_TOKEN at position 5) treats an empty string as a
  // present-but-blank credential and selects it, blocking the real token
  // from being used. Common cause: `envFrom: secretRef` over a Secret that
  // carries a stale empty key.
  const isBlank = (v: string | undefined): boolean => typeof v === "string" && v.trim() === "";
  const { ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...rest } = process.env;
  const baseEnv: Record<string, string | undefined> = { ...rest };
  if (!isBlank(ANTHROPIC_API_KEY)) baseEnv["ANTHROPIC_API_KEY"] = ANTHROPIC_API_KEY;
  if (!isBlank(CLAUDE_CODE_OAUTH_TOKEN))
    baseEnv["CLAUDE_CODE_OAUTH_TOKEN"] = CLAUDE_CODE_OAUTH_TOKEN;
  const tokenEnv: Record<string, string> =
    installationToken !== undefined && installationToken !== ""
      ? { GH_TOKEN: installationToken, GITHUB_TOKEN: installationToken }
      : {};
  // Sibling scratch dir for agent-authored summaries. Exposed so the
  // implement/review/resolve prompts can reference $BOT_ARTIFACT_DIR
  // without leaking the path into commits inside the cloned repo.
  const artifactEnv: Record<string, string> =
    artifactsDir !== undefined && artifactsDir !== "" ? { BOT_ARTIFACT_DIR: artifactsDir } : {};
  if (config.provider === "bedrock") {
    return { ...baseEnv, ...tokenEnv, ...artifactEnv, CLAUDE_CODE_USE_BEDROCK: "1" };
  }
  return { ...baseEnv, ...tokenEnv, ...artifactEnv };
}

/**
 * Execute Claude Agent SDK with the built prompt and MCP servers.
 * The SDK streams messages; we collect them for result metadata.
 *
 * Ported from claude-code-action's base-action/src/run-claude-sdk.ts
 * Per Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/quickstart
 *
 * Key difference: we pass `cwd` pointing to the cloned repo directory
 * so Claude's file tools (Read/Write/Edit/Glob/Grep/LS) operate on real local files.
 */
export interface ExecuteAgentParams {
  ctx: BotContext;
  prompt: string;
  mcpServers: McpServerConfig;
  workDir: string;
  /**
   * Sibling scratch directory for agent-authored summary files (IMPLEMENT.md,
   * REVIEW.md, RESOLVE.md). Exported to the agent subprocess as
   * `BOT_ARTIFACT_DIR`. Lives outside `workDir` so the agent cannot
   * accidentally `git add` these files.
   */
  artifactsDir?: string;
  allowedTools: string[];
  maxTurns?: number;
  installationToken?: string;
  /**
   * Optional caller-supplied abort signal. When aborted, the SDK `query()`
   * iterator is torn down (via the controller plumbed into `queryOptions`),
   * the Claude Code subprocess and MCP servers exit, and `executeAgent`
   * resolves with `success: false`. The wall-clock timeout is implemented
   * by the same mechanism, so an external abort short-circuits the timer.
   */
  signal?: AbortSignal;
}

export async function executeAgent({
  ctx,
  prompt,
  mcpServers,
  workDir,
  artifactsDir,
  allowedTools,
  maxTurns,
  installationToken,
  signal,
}: ExecuteAgentParams): Promise<ExecutionResult> {
  const { log } = ctx;

  log.info(
    {
      workDir,
      mcpServerCount: Object.keys(mcpServers).length,
      provider: config.provider,
      configModel: config.model,
      configPermissionMode: "bypassPermissions",
      allowedToolsCount: allowedTools.length,
    },
    "Starting Claude Agent SDK execution",
  );

  const startTime = Date.now();
  let result: SDKResultMessage | undefined;

  // Cancellation controller plumbed into the SDK so the wall-clock timer and
  // any caller-supplied AbortSignal actually tear down the `query()` async
  // iterator (and the underlying Claude Code subprocess + MCP servers).
  // Without this, the SDK keeps streaming tokens and writing to the workspace
  // long after `executeAgent` returns — see issue #16.
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  // Build query options. model and maxTurns are only included when set
  // (exactOptionalPropertyTypes forbids assigning undefined to optional
  // properties). When maxTurns is omitted entirely, the SDK runs the agent
  // to completion — that's the default we want for end-to-end workflows.
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    cwd: workDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools,
    mcpServers,
    systemPrompt: { type: "preset", preset: "claude_code" },
    env: buildProviderEnv(installationToken, artifactsDir),
    abortController: controller,
  };
  const resolvedMaxTurns = maxTurns ?? config.agentMaxTurns;
  if (resolvedMaxTurns !== undefined) {
    queryOptions.maxTurns = resolvedMaxTurns;
  }
  queryOptions.model = config.model;
  if (config.claudeCodePath !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = config.claudeCodePath;
  }

  log.info(
    {
      queryModel: queryOptions.model ?? "(not set)",
      queryPermissionMode: queryOptions.permissionMode,
      queryMaxTurns: queryOptions.maxTurns,
      queryCwd: queryOptions.cwd,
      queryAllowedTools: queryOptions.allowedTools,
    },
    "Agent SDK query options built",
  );

  // Bound wall-clock time to prevent a hung model response or MCP server from
  // holding an activeCount slot and a cloned workspace indefinitely, which would
  // eventually exhaust MAX_CONCURRENT_REQUESTS for all subsequent requests.
  // The timer aborts the SDK controller (rather than just rejecting a racing
  // promise) so the iterator stops consuming tokens and the subprocess exits.
  // The Error is hoisted so the catch block can identify a timer-fired abort
  // by reference (controller.signal.reason === timeoutError) rather than a
  // separate flag — also avoids constructing the same message twice.
  const timeoutError = new Error(`Agent execution timed out after ${config.agentTimeoutMs}ms`);
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, config.agentTimeoutMs);

  try {
    const agentLoop = (async (): Promise<void> => {
      for await (const message of query({ prompt, options: queryOptions })) {
        const msg = message as Record<string, unknown>;
        const msgType = typeof msg["type"] === "string" ? msg["type"] : "unknown";

        if (msgType === "system") {
          log.info(
            { sdkMsgType: msgType, subtype: msg["subtype"], model: msg["model"] },
            "SDK system message",
          );
        } else if (msgType === "assistant") {
          const betaMsg = msg["message"] as Record<string, unknown> | undefined;
          const model = betaMsg?.["model"];
          const stopReason = betaMsg?.["stop_reason"];
          const content = betaMsg?.["content"] as Record<string, unknown>[] | undefined;
          const toolUses = content?.filter((b) => b["type"] === "tool_use");
          const textBlocks = content?.filter((b) => b["type"] === "text");
          const textPreview = textBlocks
            ?.map((b) => {
              const t = b["text"];
              return typeof t === "string" ? t.slice(0, 200) : "";
            })
            .join(" | ");
          const toolNames = toolUses?.map((b) => {
            const n = b["name"];
            return typeof n === "string" ? n : "";
          });
          log.info(
            {
              sdkMsgType: msgType,
              model,
              stopReason,
              toolUses: toolNames,
              textPreview:
                textPreview !== undefined && textPreview !== "" ? textPreview : undefined,
            },
            "SDK assistant message",
          );
        } else if (msgType === "result") {
          log.info({ sdkMsgType: msgType, subtype: msg["subtype"] }, "SDK result message");
        }

        // isResultMessage guards against the SDK message union resolving to
        // `any` in ESLint's type graph — ensures safe property access.
        if (isResultMessage(message)) {
          result = message;
        }
      }
    })();

    await agentLoop;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    // Identity comparison on the abort reason gives us the right answer even
    // when a caller-supplied signal fires nanoseconds before the timer (the
    // controller's first abort wins; subsequent calls are no-ops). The SDK
    // rethrows the abort reason, so for timeout/caller-cancel paths `error`
    // is the same instance held in controller.signal.reason.
    const timedOut = controller.signal.reason === timeoutError;
    log.error({ err: error, durationMs, timedOut }, "Claude Agent SDK execution failed");

    return {
      success: false,
      durationMs,
      errorMessage: timedOut
        ? `Agent execution timed out after ${String(durationMs)}ms`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }

  const durationMs = Date.now() - startTime;

  log.info(
    {
      success: result?.subtype === "success",
      durationMs,
      costUsd: result?.total_cost_usd,
      numTurns: result?.num_turns,
    },
    "Claude Agent SDK execution completed",
  );

  return buildExecutionResult(result, durationMs);
}

/** Build ExecutionResult from SDK output (exactOptionalPropertyTypes-safe). */
function buildExecutionResult(
  result: SDKResultMessage | undefined,
  durationMs: number,
): ExecutionResult {
  const success = result?.subtype === "success";
  const executionResult: ExecutionResult = {
    success,
    durationMs: result?.duration_ms ?? durationMs,
  };
  if (result?.total_cost_usd !== undefined) {
    executionResult.costUsd = result.total_cost_usd;
  }
  if (result?.num_turns !== undefined) {
    executionResult.numTurns = result.num_turns;
  }
  // SDK returned a non-success terminal result (e.g. error_max_turns,
  // error_max_budget_usd) without throwing. Surface the subtype + any
  // structured error strings the SDK emitted; the executor catch path
  // owns the throw case separately.
  if (!success) {
    const subtype = result?.subtype ?? "unknown";
    const errors =
      result !== undefined && "errors" in result && Array.isArray(result.errors)
        ? (result.errors as readonly string[]).filter((s) => typeof s === "string" && s !== "")
        : [];
    executionResult.errorMessage =
      errors.length > 0
        ? `SDK ${subtype}: ${errors.join("; ")}`
        : `SDK terminal subtype: ${subtype}`;
  }
  return executionResult;
}
