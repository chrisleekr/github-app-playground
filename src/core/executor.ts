import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../config";
import type { BotContext, ExecutionResult, McpServerConfig } from "../types";

/** Narrows an unknown streamed SDK message to the final result shape. */
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
 */
function buildProviderEnv(): Record<string, string | undefined> {
  if (config.provider === "bedrock") {
    return { ...process.env, CLAUDE_CODE_USE_BEDROCK: "1" };
  }
  return { ...process.env };
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
export async function executeAgent(
  ctx: BotContext,
  prompt: string,
  mcpServers: McpServerConfig,
  workDir: string,
  allowedTools: string[],
): Promise<ExecutionResult> {
  const { log } = ctx;

  log.info(
    { workDir, mcpServerCount: Object.keys(mcpServers).length, provider: config.provider },
    "Starting Claude Agent SDK execution",
  );

  const startTime = Date.now();
  let result: SDKResultMessage | undefined;

  // Build query options. model is only included when set (exactOptionalPropertyTypes
  // forbids assigning undefined to optional properties).
  const queryOptions: Parameters<typeof query>[0]["options"] = {
    cwd: workDir,
    permissionMode: "bypassPermissions",
    allowedTools,
    mcpServers,
    maxTurns: 50, // Safety limit per hosting guide
    systemPrompt: { type: "preset", preset: "claude_code" },
    env: buildProviderEnv(),
  };
  if (config.model !== undefined) {
    queryOptions.model = config.model;
  }
  if (config.claudeCodePath !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = config.claudeCodePath;
  }

  try {
    // Bound wall-clock time to prevent a hung model response or MCP server from
    // holding an activeCount slot and a cloned workspace indefinitely, which would
    // eventually exhaust MAX_CONCURRENT_REQUESTS for all subsequent requests.
    const agentLoop = (async (): Promise<void> => {
      for await (const message of query({ prompt, options: queryOptions })) {
        // Capture the final result message for metadata.
        // isResultMessage guards against the SDK message union resolving to
        // `any` in ESLint's type graph — ensures safe property access.
        if (isResultMessage(message)) {
          result = message;
        }
      }
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Agent execution timed out after ${config.agentTimeoutMs}ms`)),
        config.agentTimeoutMs,
      );
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

  // Build result, omitting optional fields when undefined
  // (exactOptionalPropertyTypes forbids assigning undefined to optional props)
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
