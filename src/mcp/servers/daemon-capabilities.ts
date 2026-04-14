import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Daemon Capabilities MCP Server (Tier 3, R-011).
 *
 * Exposes a `query_daemon_capabilities` tool that returns the full
 * DaemonCapabilities JSON for the executing daemon. This gives the Claude
 * agent runtime awareness of the daemon's local environment.
 *
 * The capabilities JSON is passed via the DAEMON_CAPABILITIES env var
 * (set by the daemon job executor when spawning the MCP server).
 */

const server = new McpServer({
  name: "daemon_capabilities",
  version: "1.0.0",
});

server.registerTool(
  "query_daemon_capabilities",
  {
    description:
      "Returns the full capabilities of the daemon executing this job, including platform, CLI tools, container runtime, resources (CPU, memory, disk), and network info.",
  },
  () => {
    const capsJson = process.env["DAEMON_CAPABILITIES"];
    if (capsJson === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Daemon capabilities not available (inline mode)" }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: capsJson }],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main();
