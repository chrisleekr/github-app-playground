/**
 * MCP server exposing the GraphQL `resolveReviewThread` mutation as a
 * single tool consumable by the Claude Agent SDK during `resolve` handler
 * execution. Per `contracts/mcp-resolve-thread-server.md` (T029).
 *
 * Single tool: `resolve_review_thread(thread_id)`.
 * Bound to one `(owner, repo, pull_number)` at startup via env vars; the
 * server refuses to resolve a thread belonging to a different PR.
 *
 * Environment variables (validated at startup, fail-fast):
 *   GITHUB_TOKEN   — installation token
 *   REPO_OWNER     — repo owner login
 *   REPO_NAME      — repo name
 *   PR_NUMBER      — pull request number this server is bound to
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

const REPO_OWNER = process.env["REPO_OWNER"];
const REPO_NAME = process.env["REPO_NAME"];
const PR_NUMBER = process.env["PR_NUMBER"];
const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];

if (
  REPO_OWNER === undefined ||
  REPO_OWNER === "" ||
  REPO_NAME === undefined ||
  REPO_NAME === "" ||
  PR_NUMBER === undefined ||
  PR_NUMBER === "" ||
  GITHUB_TOKEN === undefined ||
  GITHUB_TOKEN === ""
) {
  console.error("Error: REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN are required");
  process.exit(1);
}

const BOUND_PR_NUMBER = parseInt(PR_NUMBER, 10);
if (!Number.isInteger(BOUND_PR_NUMBER) || BOUND_PR_NUMBER <= 0) {
  console.error(`Error: PR_NUMBER must be a positive integer, got '${PR_NUMBER}'`);
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new McpServer({
  name: "GitHub Resolve Review Thread Server",
  version: "1.0.0",
});

const GET_THREAD_QUERY = `
  query GetReviewThread($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        pullRequest {
          number
        }
      }
    }
  }
`;

const RESOLVE_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
        pullRequest {
          number
        }
      }
    }
  }
`;

interface PreflightResponse {
  node: {
    id: string;
    pullRequest: { number: number };
  } | null;
}

interface ResolveResponse {
  resolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
      pullRequest: { number: number };
    };
  };
}

type ErrorCode =
  | "thread_not_found"
  | "permission_denied"
  | "rate_limited"
  | "network_error"
  | "graphql_error";

function classifyError(err: unknown): ErrorCode {
  const status = (err as { status?: number }).status;
  if (status === 404) return "thread_not_found";
  if (status === 403) return "permission_denied";
  if (status === 429) return "rate_limited";

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (message.includes("not found")) return "thread_not_found";
  if (message.includes("forbidden") || message.includes("permission")) return "permission_denied";
  if (message.includes("rate limit") || message.includes("secondary rate")) return "rate_limited";
  if (
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("network") ||
    message.includes("fetch failed")
  ) {
    return "network_error";
  }
  return "graphql_error";
}

// eslint-disable-next-line @typescript-eslint/no-deprecated -- MCP SDK migration to registerTool is tracked separately; out of scope for this feature
server.tool(
  "resolve_review_thread",
  "Mark a GitHub PR review thread as resolved. Use after replying to the thread with a comment summarising the change.",
  {
    thread_id: z
      .string()
      .min(1)
      .describe(
        "The PullRequestReviewThread node ID (from probe response reviewThreads.nodes[].id).",
      ),
  },
  async ({ thread_id }) => {
    try {
      const preflight = await octokit.graphql<PreflightResponse>(GET_THREAD_QUERY, {
        threadId: thread_id,
      });
      const preflightPr = preflight.node?.pullRequest.number;
      if (preflightPr !== BOUND_PR_NUMBER) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: "graphql_error",
                message:
                  preflightPr === undefined
                    ? `thread ${thread_id} not found or not a PullRequestReviewThread`
                    : `thread belongs to PR #${String(preflightPr)} but this server is bound to PR #${String(BOUND_PR_NUMBER)}`,
                thread_id,
              }),
            },
          ],
          isError: true,
        };
      }

      const result = await octokit.graphql<ResolveResponse>(RESOLVE_MUTATION, {
        threadId: thread_id,
      });
      const thread = result.resolveReviewThread.thread;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              thread_id: thread.id,
              is_resolved: thread.isResolved,
              pr_number: thread.pullRequest.number,
            }),
          },
        ],
      };
    } catch (err) {
      const code = classifyError(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ code, message, thread_id }),
          },
        ],
        isError: true,
      };
    }
  },
);

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    void server.close();
  });
}

void runServer().catch(console.error);
