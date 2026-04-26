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
function buildProviderEnv(installationToken?: string): Record<string, string | undefined> {
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
  if (config.provider === "bedrock") {
    return { ...baseEnv, ...tokenEnv, CLAUDE_CODE_USE_BEDROCK: "1" };
  }
  return { ...baseEnv, ...tokenEnv };
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
  allowedTools: string[];
  maxTurns?: number;
  installationToken?: string;
}

export async function executeAgent({
  ctx,
  prompt,
  mcpServers,
  workDir,
  allowedTools,
  maxTurns,
  installationToken,
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
    env: buildProviderEnv(installationToken),
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

  try {
    // Bound wall-clock time to prevent a hung model response or MCP server from
    // holding an activeCount slot and a cloned workspace indefinitely, which would
    // eventually exhaust MAX_CONCURRENT_REQUESTS for all subsequent requests.
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

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Agent execution timed out after ${config.agentTimeoutMs}ms`));
      }, config.agentTimeoutMs);
    });

    await Promise.race([agentLoop, timeoutPromise]);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error({ err: error, durationMs }, "Claude Agent SDK execution failed");

    return {
      success: false,
      durationMs,
    };
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
  const executionResult: ExecutionResult = {
    success: result?.subtype === "success",
    durationMs: result?.duration_ms ?? durationMs,
  };
  if (result?.total_cost_usd !== undefined) {
    executionResult.costUsd = result.total_cost_usd;
  }
  if (result?.num_turns !== undefined) {
    executionResult.numTurns = result.num_turns;
  }
  return executionResult;
}
