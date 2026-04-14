import type { Octokit } from "octokit";

import type { Logger } from "./logger";
import type { DaemonCapabilities, SerializableBotContext } from "./shared/daemon-types";

/**
 * Unified context for processing a webhook event.
 * Parsed from any supported webhook payload into a common shape.
 */
export interface BotContext {
  /** Repository owner (org or user) */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR or issue number */
  entityNumber: number;
  /** Whether this is a pull request (vs. issue) */
  isPR: boolean;
  /** Webhook event name */
  eventName: "issue_comment" | "pull_request_review_comment";
  /** Username of the person who triggered the bot */
  triggerUsername: string;
  /** ISO timestamp when the trigger comment was created */
  triggerTimestamp: string;
  /** Full body of the triggering comment */
  triggerBody: string;
  /** Comment ID for tracking/reply purposes */
  commentId: number;
  /** Unique webhook delivery ID (for idempotency) */
  deliveryId: string;
  /** PR head branch (only for PRs) */
  headBranch?: string;
  /** PR base branch (only for PRs) */
  baseBranch?: string;
  /** Default branch of the repository */
  defaultBranch: string;
  /** GitHub labels on the parent issue/PR at webhook trigger time */
  labels: string[];
  /** When true, skip creating/updating tracking comments on GitHub (dev testing) */
  skipTrackingComments?: boolean;
  /** When true, skip Claude Agent SDK execution and return a synthetic result (dev testing) */
  dryRun?: boolean;
  /** Pre-loaded repo memory from orchestrator (daemon mode only) */
  repoMemory?: { id: string; category: string; content: string; pinned: boolean }[];
  /** Daemon capabilities — set when running in daemon mode to enable capability-based tools */
  daemonCapabilities?: DaemonCapabilities;
  /**
   * Orchestrator-provided env vars (daemon mode only). Written as `.env` in
   * the pipeline's workspace after checkout so the agent subprocess can read
   * them. Kept on the context (rather than as a pipeline override) to mirror
   * the existing `repoMemory` threading.
   */
  envVars?: Record<string, string>;
  /** Authenticated Octokit instance for this installation */
  octokit: Octokit;
  /** Child logger scoped to this request */
  log: Logger;
}

/**
 * Result from a Claude Agent SDK execution.
 */
export interface ExecutionResult {
  /** Whether the execution completed successfully */
  success: boolean;
  /** Total API cost in USD */
  costUsd?: number;
  /** Total execution duration in milliseconds */
  durationMs?: number;
  /** Number of agent turns used */
  numTurns?: number;
  /** When true, indicates this was a dry-run (no Claude execution) */
  dryRun?: boolean;
  /** Daemon actions collected from execution (learnings and deletions from .daemon-actions.json) */
  daemonActions?: {
    learnings: { category: string; content: string }[];
    deletions: string[];
  };
}

/**
 * Data fetched about a PR or issue from GitHub GraphQL API.
 */
export interface FetchedData {
  /** PR/issue title */
  title: string;
  /** PR/issue body (markdown) */
  body: string;
  /** Current state (OPEN, CLOSED, MERGED) */
  state: string;
  /** Author login */
  author: string;
  /** Comments on the PR/issue (filtered by timestamp) */
  comments: CommentData[];
  /** Review comments (PRs only) */
  reviewComments: ReviewCommentData[];
  /** Changed files (PRs only) */
  changedFiles: ChangedFileData[];
  /** Diff text (PRs only) */
  diff?: string;
  /** Head branch (PRs only) */
  headBranch?: string;
  /** Base branch (PRs only) */
  baseBranch?: string;
  /** Head SHA (PRs only) */
  headSha?: string;
}

export interface CommentData {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewCommentData {
  author: string;
  body: string;
  path: string;
  line?: number;
  createdAt: string;
}

export interface ChangedFileData {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * BotContext enriched with branch data resolved from GraphQL.
 * headBranch and baseBranch are required here (vs optional in BotContext)
 * because they are populated by the fetcher before checkout and execution.
 * Using a distinct type avoids mutating the original context object.
 */
export interface EnrichedBotContext extends BotContext {
  headBranch: string;
  baseBranch: string;
}

/**
 * Result from repository checkout.
 */
export interface CheckoutResult {
  /** Absolute path to the cloned repo */
  workDir: string;
  /** Cleanup function -- call in finally block */
  cleanup: () => Promise<void>;
}

/**
 * MCP server definition for the Agent SDK.
 * Supports stdio (local process) and HTTP (remote) transports.
 */
export type McpServerDef =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Map of MCP server name to its definition.
 */
export type McpServerConfig = Record<string, McpServerDef>;

/**
 * Convert a BotContext into a JSON-serializable form for WebSocket transmission.
 * Strips `octokit` (class instance) and `log` (pino logger with streams).
 * Daemon reconstructs these locally from the installation token and delivery ID.
 */
export function serializeBotContext(ctx: BotContext): SerializableBotContext {
  // Destructure to remove non-serializable fields; spread the rest.

  const { octokit: _octokit, log: _log, ...serializable } = ctx;
  return serializable;
}
