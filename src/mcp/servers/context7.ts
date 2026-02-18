import { config } from "../../config";
import type { McpServerDef } from "../../types";

/**
 * Context7 MCP server definition for the registry.
 * Remote HTTP transport to https://mcp.context7.com/mcp
 *
 * Provides:
 * - resolve-library-id: resolve a library name to a Context7-compatible ID
 * - query-docs: retrieve up-to-date documentation for a library
 *
 * See: https://github.com/upstash/context7
 */
export function context7Server(): McpServerDef {
  // Build definition, conditionally including headers
  // (exactOptionalPropertyTypes forbids assigning undefined to optional Record)
  const def: McpServerDef = {
    type: "http",
    url: "https://mcp.context7.com/mcp",
  };
  // Header name confirmed per Context7 official docs:
  // https://github.com/upstash/context7#cursor-remote-server-connection
  if (config.context7ApiKey !== undefined && config.context7ApiKey !== "") {
    def.headers = { CONTEXT7_API_KEY: config.context7ApiKey };
  }
  return def;
}
