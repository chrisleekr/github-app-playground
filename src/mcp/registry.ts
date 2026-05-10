import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config } from "../config";
import type { DaemonCapabilities } from "../shared/daemon-types";
import type { BotContext, McpServerConfig, McpServerDef } from "../types";
import { context7Server } from "./servers/context7";

/**
 * Resolve the absolute filesystem path of an MCP server module by name,
 * preferring the compiled `.js` if present (prod image) and falling back to
 * `.ts` for dev. Heuristics like `import.meta.url.includes("/src/")` are
 * brittle: container images with a `/src/` segment in their WORKDIR would
 * false-positive and pick a `.ts` that does not exist after compilation.
 * existsSync against both candidates is path-shape-agnostic and removes the
 * 6-fold duplication that previously lived in this file.
 */
function resolveServerPath(name: string): string {
  const jsPath = fileURLToPath(new URL(`./servers/${name}.js`, import.meta.url));
  if (existsSync(jsPath)) return jsPath;
  const tsPath = fileURLToPath(new URL(`./servers/${name}.ts`, import.meta.url));
  if (existsSync(tsPath)) return tsPath;
  // Surface a clear, actionable error rather than letting bun fail with a
  // bare ENOENT inside an MCP server subprocess (which only shows up as
  // status:"failed" in the SDK init message).
  throw new Error(
    `MCP server module not found for "${name}": neither ${jsPath} nor ${tsPath} exists.`,
  );
}

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
   * open review threads: keeps the tool out of contexts where it isn't
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

  // Tier 3, R-011, daemon capabilities MCP server
  if (opts?.daemonCapabilities !== undefined) {
    servers["daemon_capabilities"] = daemonCapabilitiesServerDef(opts.daemonCapabilities);
  }

  // Repo memory MCP server, persistent learnings across executions
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
  const serverPath = resolveServerPath("comment");
  return {
    type: "stdio",
    command: "bun",
    args: ["run", serverPath],
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
  const serverPath = resolveServerPath("inline-comment");
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
 * Resolve-review-thread server definition (stdio transport, PRs only,
 * opt-in via `enableResolveReviewThread`). Bound to a single PR at
 * construction; the server refuses to resolve threads on other PRs
 * (T029 contract §Security).
 */
function resolveReviewThreadServerDef(
  sharedEnv: Record<string, string>,
  prNumber: number,
): McpServerDef {
  const serverPath = resolveServerPath("resolve-review-thread");
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
  const serverPath = resolveServerPath("github-state");
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
  const serverPath = resolveServerPath("daemon-capabilities");

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
  const serverPath = resolveServerPath("repo-memory");

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
