# Extending the Bot

This guide explains how to add new webhook event handlers and MCP servers.
The codebase is designed so that both extension points follow a consistent pattern
with minimal boilerplate.

---

## Adding a New Webhook Event Handler

### When to add one

Add a new handler when you want the bot to react to a GitHub event that is not yet
handled — for example, `pull_request.closed`, `issue.opened`, or `push`.

### Step 1 — Subscribe to the event in the GitHub App settings

The GitHub App must be subscribed to the event before GitHub will deliver it.

1. Go to **Settings > Developer settings > GitHub Apps > your app > Permissions & events**.
2. Under **Subscribe to events**, check the event you want to handle.
3. Click **Save changes**.

### Step 2 — Create a handler file in `src/webhook/events/`

Each handler file exports a single function that receives `(octokit, payload, deliveryId)`.
Use an existing handler as a template.

**Template — event that triggers the bot:**

```typescript
// src/webhook/events/my-event.ts
import type { MyEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { parseMyEvent } from "../../core/context"; // add a parser (see Step 3)
import { containsTrigger } from "../../core/trigger";
import { logger } from "../../logger";
import { processRequest } from "../router";

export function handleMyEvent(octokit: Octokit, payload: MyEvent, deliveryId: string): void {
  // Filter to the specific action(s) you care about
  if (payload.action !== "created") return;

  // Skip bot comments to avoid self-triggering loops
  if (payload.comment.user.type === "Bot") return;

  // Only proceed when the trigger phrase is present
  if (!containsTrigger(payload.comment.body)) return;

  logger.info(
    { deliveryId, owner: payload.repository.owner.login, repo: payload.repository.name },
    "Trigger detected in my_event",
  );

  const ctx = parseMyEvent(payload, octokit, deliveryId);

  // Fire-and-forget — webhook must respond within 10 s
  processRequest(ctx).catch((err) => {
    ctx.log.error({ err }, "Async processing failed for my_event");
  });
}
```

**Template — event that only logs (placeholder):**

See `src/webhook/events/pull-request.ts` for the minimal placeholder pattern used
for events that are subscribed but not yet fully implemented.

### Step 3 — Add a context parser in `src/core/context.ts`

`processRequest()` requires a `BotContext`. Add a `parse*` function that maps the
raw webhook payload to the `BotContext` interface defined in `src/types.ts`.

The existing `parseIssueCommentEvent` and `parseReviewCommentEvent` functions in
`src/core/context.ts` show the expected field mapping.

### Step 4 — Register the handler in `src/app.ts`

```typescript
// src/app.ts
import { handleMyEvent } from "./webhook/events/my-event";

// Inside the file, alongside the other registrations:
app.webhooks.on("my_event.created", ({ octokit, payload, id }) => {
  handleMyEvent(octokit, payload as unknown as MyEvent, id);
});
```

The `@octokit/webhooks-types` package provides TypeScript types for every GitHub
webhook payload. Import the matching type for your event.

### Step 5 — Add tests

Add a test file at `test/webhook/events/my-event.test.ts`. Use the existing test
files as a template.

---

## Adding a New MCP Server

### When to add one

Add a new MCP server when you want to give Claude access to a new tool — for
example, a tool that posts to Slack, queries a database, or calls an external API.

### Transport types

| Type    | When to use                                                     | Example       |
| ------- | --------------------------------------------------------------- | ------------- |
| `stdio` | Local process; needs per-request secrets (tokens, IDs)          | `comment.ts`  |
| `http`  | Remote service with a stable URL; no per-request process needed | `context7.ts` |

### Option A — stdio server (local process)

A stdio server is spawned as a child process per request. The registry passes
environment variables that carry per-request context (tokens, IDs).

#### 1. Create the server file in `src/mcp/servers/`

```typescript
// src/mcp/servers/my-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Read env vars injected by the registry
const MY_VAR = process.env["MY_VAR"];
if (!MY_VAR) {
  console.error("Error: MY_VAR is required");
  process.exit(1);
}

const server = new McpServer({ name: "My Server", version: "1.0.0" });

server.tool(
  "my_tool",
  "Description Claude sees when deciding whether to use this tool",
  { input: z.string().describe("Tool input") },
  async ({ input }) => {
    // ... implementation ...
    return { content: [{ type: "text" as const, text: "result" }] };
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
```

#### 2. Register the server definition in `src/mcp/registry.ts`

```typescript
// src/mcp/registry.ts
function myServerDef(sharedEnv: Record<string, string>): McpServerDef {
  return {
    type: "stdio",
    command: "bun",
    args: ["run", "src/mcp/servers/my-server.ts"],
    env: { ...sharedEnv, MY_VAR: "value" },
  };
}

// Inside resolveMcpServers():
servers["my_server"] = myServerDef(sharedEnv);
```

The `sharedEnv` object already carries `GITHUB_TOKEN`, `REPO_OWNER`, `REPO_NAME`,
and `GITHUB_EVENT_NAME`. Spread it and add your own variables.

#### 3. Add the server source to the Docker production stage

stdio servers run as source files via `bun run src/mcp/servers/*.ts`.
The `Dockerfile` already copies the entire `src/mcp/` directory to the production
image, so new server files under `src/mcp/servers/` are included automatically.
No Dockerfile change is needed.

---

### Option B — HTTP server (remote)

An HTTP server is not spawned as a process — the Agent SDK connects to its URL
directly. Use this for external services like Context7.

#### 1. Create a factory function in `src/mcp/servers/`

```typescript
// src/mcp/servers/my-remote.ts
import type { McpServerDef } from "../../types";

export function myRemoteServer(): McpServerDef {
  return {
    type: "http",
    url: "https://my-service.example.com/mcp",
    headers: { Authorization: `Bearer ${process.env["MY_API_KEY"]}` },
  };
}
```

#### 2. Register in `src/mcp/registry.ts`

```typescript
import { myRemoteServer } from "./servers/my-remote";

// Inside resolveMcpServers(), conditionally when credentials are present:
if (config.myApiKey) {
  servers["my_remote"] = myRemoteServer();
}
```

#### 3. Add the env var to `src/config.ts`

Follow the existing `context7ApiKey` pattern: add an optional Zod field, read the
environment variable in `loadConfig()`, and document it in `docs/SETUP.md`.

---

## Reference — Key Interfaces

The `McpServerDef` type in `src/types.ts` defines both transport shapes:

```typescript
type McpServerDef =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };
```

`BotContext` in `src/types.ts` defines the fields available to event handlers and
the processing pipeline (owner, repo, entityNumber, isPR, eventName, etc.).
