import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "octokit";
import { z } from "zod";

import { sanitizeContent } from "../../utils/sanitize";

/**
 * MCP server for creating inline PR review comments.
 * Provides create_inline_comment tool (PRs only).
 *
 * Ported from claude-code-action's src/mcp/github-inline-comment-server.ts
 *
 * Environment variables:
 * - GITHUB_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER
 */
// Validate all required env vars at startup for fail-fast behavior.
// Errors here surface immediately in logs rather than on the first tool call.
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

// Create Octokit once at startup — GITHUB_TOKEN is constant for the server lifetime.
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new McpServer({
  name: "GitHub Inline Comment Server",
  version: "1.0.0",
});

server.tool(
  "create_inline_comment",
  "Create an inline comment on a specific line or lines in a PR file",
  {
    path: z.string().describe("The file path to comment on (e.g., 'src/index.js')"),
    body: z
      .string()
      .describe(
        "The comment text (supports markdown and GitHub code suggestion blocks). " +
          "For code suggestions, use: ```suggestion\\nreplacement code\\n```. " +
          "IMPORTANT: The suggestion block will REPLACE the ENTIRE line range.",
      ),
    line: z
      .number()
      .min(1)
      .describe("Line number (end line for multi-line comments). Required. Must be >= 1."),
    startLine: z
      .number()
      .min(1)
      .optional()
      .describe("Start line for multi-line comments (use with line as end). Must be >= 1."),
    side: z
      .enum(["LEFT", "RIGHT"])
      .optional()
      .default("RIGHT")
      .describe("Side of the diff to comment on: LEFT (old) or RIGHT (new)"),
    commit_id: z
      .string()
      .optional()
      .describe("Specific commit SHA to comment on (defaults to latest commit)"),
  },
  async ({ path, body, line, startLine, side, commit_id }) => {
    try {
      const pull_number = parseInt(PR_NUMBER, 10);
      const sanitizedBody = sanitizeContent(body);

      const isSingleLine = startLine === undefined;

      // Get latest commit SHA if not provided
      let commitSha = commit_id;
      if (commitSha === undefined || commitSha === "") {
        const pr = await octokit.rest.pulls.get({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          pull_number,
        });
        commitSha = pr.data.head.sha;
      }

      const params: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        pull_number,
        body: sanitizedBody,
        path,
        side,
        commit_id: commitSha,
      };

      if (isSingleLine) {
        params.line = line;
      } else {
        params.start_line = startLine;
        params.start_side = side;
        params.line = line;
      }

      const result = await octokit.rest.pulls.createReviewComment(params);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              comment_id: result.data.id,
              html_url: result.data.html_url,
              path: result.data.path,
              line: result.data.line ?? result.data.original_line,
              message: `Inline comment created on ${path}${
                isSingleLine ? ` at line ${line}` : ` from line ${startLine} to ${line}`
              }`,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      let helpMessage = "";
      if (errorMessage.includes("Validation Failed")) {
        helpMessage =
          "\n\nThe line number doesn't exist in the diff or the file path is incorrect.";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating inline comment: ${errorMessage}${helpMessage}`,
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
