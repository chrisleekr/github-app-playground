import { config } from "../config";
import type { DaemonCapabilities } from "../shared/daemon-types";
import type { BotContext, McpServerConfig, McpServerDef } from "../types";
import { context7Server } from "./servers/context7";

/**
 * Resolve which MCP servers to activate based on the BotContext.
 * Returns a map of server name → server definition for the Agent SDK.
 *
 * Extensible: add new servers by creating a file in src/mcp/servers/
 * and registering it here.
 */
export interface RepoMemoryEntry {
  id: string;
  category: string;
  content: string;
  pinned: boolean;
}

export interface ResolveMcpServersOptions {
  daemonCapabilities?: DaemonCapabilities;
  workDir?: string;
  repoMemory?: RepoMemoryEntry[];
  /**
   * Opt-in for the resolve-review-thread MCP server (T029/T030). Set
   * `true` when the agent is running the `resolve` step and the PR has
   * open review threads — keeps the tool out of contexts where it isn't
   * relevant per Constitution VII single-responsibility.
   */
  enableResolveReviewThread?: boolean;
  /**
   * Opt-in for the read-only `github-state` MCP server (issue #117). Set
   * `true` for executors that benefit from on-demand fetches of CI rollup,
   * check-run output, branch protection, PR diff, or paginated comments.
   * Keeps the tool surface out of contexts where the LLM has no reason to
   * reach for fresh GitHub state.
   */
  enableGithubState?: boolean;
}

export function resolveMcpServers(
  ctx: BotContext,
  trackingCommentId: number | undefined,
  installationToken: string,
  opts?: ResolveMcpServersOptions,
): McpServerConfig {
  const servers: McpServerConfig = {};

  const sharedEnv: Record<string, string> = {
    GITHUB_TOKEN: installationToken,
    REPO_OWNER: ctx.owner,
    REPO_NAME: ctx.repo,
  };

  if (trackingCommentId !== undefined) {
    servers["github_comment"] = commentServerDef(sharedEnv, trackingCommentId, ctx.deliveryId);
  }

  if (ctx.isPR) {
    servers["github_inline_comment"] = inlineCommentServerDef(sharedEnv, ctx.entityNumber);
    if (opts?.enableResolveReviewThread === true) {
      servers["resolve_review_thread"] = resolveReviewThreadServerDef(sharedEnv, ctx.entityNumber);
    }
  }

  if (config.context7ApiKey !== undefined && config.context7ApiKey !== "") {
    servers["context7"] = context7Server();
  }

  if (opts?.enableGithubState === true) {
    servers["github_state"] = githubStateServerDef(sharedEnv);
  }

  // Tier 3, R-011 — daemon capabilities MCP server
  if (opts?.daemonCapabilities !== undefined) {
    servers["daemon_capabilities"] = daemonCapabilitiesServerDef(opts.daemonCapabilities);
  }

  // Repo memory MCP server — persistent learnings across executions
  if (opts?.workDir !== undefined) {
    servers["repo_memory"] = repoMemoryServerDef(opts.workDir, opts.repoMemory ?? []);
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

/**
 * Resolve-review-thread server definition (stdio transport, PRs only,
 * opt-in via `enableResolveReviewThread`). Bound to a single PR at
 * construction; the server refuses to resolve threads on other PRs
 * (T029 contract §Security).
 */
function resolveReviewThreadServerDef(
  sharedEnv: Record<string, string>,
  prNumber: number,
): McpServerDef {
  const isDev = import.meta.url.includes("/src/");
  const serverPath = isDev
    ? new URL("./servers/resolve-review-thread.ts", import.meta.url).pathname
    : "dist/mcp/servers/resolve-review-thread.js";
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      ...sharedEnv,
      PR_NUMBER: prNumber.toString(),
    },
  };
}

/**
 * Read-only github-state server definition (stdio transport, opt-in via
 * `enableGithubState`). Hard-pinned to the current repo via env so the
 * model cannot fan out to arbitrary repos.
 */
function githubStateServerDef(sharedEnv: Record<string, string>): McpServerDef {
  const isDev = import.meta.url.includes("/src/");
  const serverPath = isDev
    ? new URL("./servers/github-state.ts", import.meta.url).pathname
    : "dist/mcp/servers/github-state.js";
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: { ...sharedEnv },
  };
}

/**
 * Daemon capabilities MCP server definition (stdio transport).
 * Passes the full DaemonCapabilities JSON via env var.
 */
function daemonCapabilitiesServerDef(capabilities: DaemonCapabilities): McpServerDef {
  const isDev = import.meta.url.includes("/src/");
  const serverPath = isDev
    ? new URL("./servers/daemon-capabilities.ts", import.meta.url).pathname
    : new URL("./servers/daemon-capabilities.js", import.meta.url).pathname;

  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      DAEMON_CAPABILITIES: JSON.stringify(capabilities),
    },
  };
}

/**
 * Repo memory MCP server definition (stdio transport).
 * Passes the workDir and pre-loaded memory via env vars.
 */
function repoMemoryServerDef(workDir: string, memory: RepoMemoryEntry[]): McpServerDef {
  const isDev = import.meta.url.includes("/src/");
  const serverPath = isDev
    ? new URL("./servers/repo-memory.ts", import.meta.url).pathname
    : new URL("./servers/repo-memory.js", import.meta.url).pathname;

  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
    env: {
      WORK_DIR: workDir,
      REPO_MEMORY: JSON.stringify(memory),
    },
  };
}
