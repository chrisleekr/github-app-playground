import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sanitizeRepoMemoryContent } from "../../utils/sanitize";

/**
 * MCP server for persistent repo memory.
 * Provides tools for Claude to save, delete, and read learnings about a repository.
 *
 * Learnings are accumulated in a JSON file (.daemon-actions.json) in the workDir.
 * After execution, the daemon reads this file and sends actions to the orchestrator
 * via job:result, which persists them to Postgres.
 *
 * Environment variables (passed by the executor):
 * - WORK_DIR: Path to the cloned repo working directory
 * - REPO_MEMORY: JSON string of pre-loaded memory entries from orchestrator
 */

const WORK_DIR = process.env["WORK_DIR"];
const REPO_MEMORY = process.env["REPO_MEMORY"];

if (WORK_DIR === undefined || WORK_DIR === "") {
  console.error("Error: WORK_DIR env var is required");
  process.exit(1);
}

const ACTIONS_FILE = join(WORK_DIR, ".daemon-actions.json");

const VALID_CATEGORIES = ["setup", "architecture", "conventions", "env", "gotchas"] as const;

// Action file helpers

interface SaveAction {
  type: "save";
  category: string;
  content: string;
}

interface DeleteAction {
  type: "delete";
  id: string;
}

type DaemonAction = SaveAction | DeleteAction;

function readActions(): DaemonAction[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (existsSync(ACTIONS_FILE)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return JSON.parse(readFileSync(ACTIONS_FILE, "utf-8")) as DaemonAction[];
    }
  } catch {
    // Corrupted file, start fresh
  }
  return [];
}

function appendAction(action: DaemonAction): void {
  const actions = readActions();
  actions.push(action);
  writeFileSync(ACTIONS_FILE, JSON.stringify(actions, null, 2)); // eslint-disable-line security/detect-non-literal-fs-filename
}

// MCP Server

const server = new McpServer({
  name: "repo_memory",
  version: "1.0.0",
});

server.registerTool(
  "save_repo_memory",
  {
    description:
      "Save a learning about this repository for future executions. Use this when you discover important information about setup steps, build/test commands, architecture, coding conventions, or common gotchas. Be specific and actionable, future executions will see this in their context.",
    inputSchema: {
      category: z
        .enum(VALID_CATEGORIES)
        .describe(
          "Category: 'setup' (build/test commands), 'architecture' (code structure), 'conventions' (coding style), 'env' (environment requirements), 'gotchas' (common pitfalls)",
        ),
      content: z
        .string()
        .min(1)
        .max(1000)
        .describe("The learning to save. Be specific and actionable."),
    },
  },
  ({ category, content }) => {
    // Untrusted-input boundary: memory rows are surfaced as data on every
    // future run, so strip injection vectors before they reach the daemon
    // scratch file. See issue #112 for the cross-session indirect-injection
    // chain that motivates this guard.
    const safeContent = sanitizeRepoMemoryContent(content);
    if (safeContent === "") {
      // Content collapsed to empty (entirely an HTML comment, invisibles, or
      // similar). Don't append an action: saveRepoLearnings would skip it on
      // the orchestrator side anyway, and signalling success here would
      // leave the agent thinking it wrote something it did not.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              saved: false,
              category,
              reason: "empty_after_sanitize",
            }),
          },
        ],
      };
    }
    appendAction({ type: "save", category, content: safeContent });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ saved: true, category, content: safeContent }),
        },
      ],
    };
  },
);

server.registerTool(
  "delete_repo_memory",
  {
    description:
      "Remove an outdated or incorrect memory about this repository. Use the ID shown in the <repo_memory> section (e.g., the UUID after 'id:'). Call this when you discover a previous learning is no longer accurate.",
    inputSchema: {
      id: z.string().min(1).describe("The memory ID to delete (UUID from <repo_memory>)."),
    },
  },
  ({ id }) => {
    appendAction({ type: "delete", id });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ deleted: true, id }),
        },
      ],
    };
  },
);

server.registerTool(
  "get_repo_memory",
  {
    description:
      "Retrieve previously saved learnings about this repository. Returns all currently active memory entries including their IDs, categories, and content.",
  },
  () => {
    const memory = REPO_MEMORY ?? "[]";
    return {
      content: [{ type: "text" as const, text: memory }],
    };
  },
);

// Start

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
