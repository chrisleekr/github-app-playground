import { config } from "../config";
import type { BotContext, McpServerConfig, McpServerDef } from "../types";
import { context7Server } from "./servers/context7";

/**
 * Resolve which MCP servers to activate based on the BotContext.
 * Returns a map of server name → server definition for the Agent SDK.
 *
 * Extensible: add new servers by creating a file in src/mcp/servers/
 * and registering it here.
 */
export function resolveMcpServers(
  ctx: BotContext,
  trackingCommentId: number,
  installationToken: string,
): McpServerConfig {
  const servers: McpServerConfig = {};

  // Shared environment for all stdio MCP servers
  const sharedEnv: Record<string, string> = {
    GITHUB_TOKEN: installationToken,
    REPO_OWNER: ctx.owner,
    REPO_NAME: ctx.repo,
  };

  // Always: tracking comment server (update_claude_comment)
  servers["github_comment"] = commentServerDef(sharedEnv, trackingCommentId, ctx.deliveryId);

  // PRs only: inline comment server (create_inline_comment)
  if (ctx.isPR) {
    servers["github_inline_comment"] = inlineCommentServerDef(sharedEnv, ctx.entityNumber);
  }

  // Always: Context7 for up-to-date library documentation (remote HTTP)
  // Helps Claude reference current APIs when reviewing code
  if (config.context7ApiKey !== undefined && config.context7ApiKey !== "") {
    servers["context7"] = context7Server();
  }

  return servers;
}

/**
 * Comment server definition (stdio transport).
 * Runs as a child process with env vars for the specific request.
 */
function commentServerDef(
  sharedEnv: Record<string, string>,
  trackingCommentId: number,
  deliveryId: string,
): McpServerDef {
  return {
    type: "stdio",
    command: "bun",
    args: ["run", "dist/mcp/servers/comment.js"],
    env: {
      ...sharedEnv,
      CLAUDE_COMMENT_ID: trackingCommentId.toString(),
      // Passed so comment.ts can re-prepend the delivery marker after sanitizeContent strips it.
      DELIVERY_ID: deliveryId,
    },
  };
}

/**
 * Inline comment server definition (stdio transport, PRs only).
 */
function inlineCommentServerDef(sharedEnv: Record<string, string>, prNumber: number): McpServerDef {
  return {
    type: "stdio",
    command: "bun",
    args: ["run", "dist/mcp/servers/inline-comment.js"],
    env: {
      ...sharedEnv,
      PR_NUMBER: prNumber.toString(),
    },
  };
}
