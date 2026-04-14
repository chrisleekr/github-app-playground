import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import { createNodeMiddleware } from "@octokit/webhooks";
import type {
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
  PullRequestReviewThreadEvent,
} from "@octokit/webhooks-types";
import { App } from "octokit";

import { config } from "./config";
import { closeDb, getDb } from "./db";
import { runMigrations } from "./db/migrate";
import { logger } from "./logger";
import { recoverStaleExecutions } from "./orchestrator/history";
import { closeValkey, getValkeyClient, isValkeyHealthy } from "./orchestrator/valkey";
import { startWebSocketServer, stopWebSocketServer } from "./orchestrator/ws-server";
import type { BotContext } from "./types";
import { handleIssueComment } from "./webhook/events/issue-comment";
import { handlePullRequest } from "./webhook/events/pull-request";
import { handleReview } from "./webhook/events/review";
import { handleReviewComment } from "./webhook/events/review-comment";
import { handleReviewThread } from "./webhook/events/review-thread";

/**
 * Main HTTP server entry point.
 *
 * Uses octokit App class per GitHub tutorial:
 * https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
 *
 * createNodeMiddleware auto-verifies HMAC-SHA256 signatures per:
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
// Server mode: appId, privateKey, webhookSecret are guaranteed present by config superRefine
// (only optional for daemon-only mode when ORCHESTRATOR_URL is set).
if (
  config.appId === undefined ||
  config.privateKey === undefined ||
  config.webhookSecret === undefined
) {
  throw new Error(
    "Server mode requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_WEBHOOK_SECRET",
  );
}
const app = new App({
  appId: config.appId,
  privateKey: config.privateKey,
  webhooks: { secret: config.webhookSecret },
});

app.webhooks.on("issue_comment.created", ({ octokit, payload, id }) => {
  handleIssueComment(octokit, payload as unknown as IssueCommentEvent, id);
});

app.webhooks.on("pull_request.opened", ({ octokit, payload, id }) => {
  handlePullRequest(octokit, payload as unknown as PullRequestEvent, id);
});

app.webhooks.on("pull_request_review.submitted", ({ octokit, payload, id }) => {
  handleReview(octokit, payload as unknown as PullRequestReviewEvent, id);
});

app.webhooks.on("pull_request_review_comment.created", ({ octokit, payload, id }) => {
  handleReviewComment(octokit, payload as unknown as PullRequestReviewCommentEvent, id);
});

// "pull_request_review_thread.created" is NOT a valid GitHub action.
// The correct actions are "resolved" and "unresolved".
app.webhooks.on(
  ["pull_request_review_thread.resolved", "pull_request_review_thread.unresolved"],
  ({ octokit, payload, id }) => {
    handleReviewThread(octokit, payload as unknown as PullRequestReviewThreadEvent, id);
  },
);

app.webhooks.onError((error) => {
  logger.error({ err: error }, "Webhook processing error");
});

// Create the webhook middleware that handles signature verification.
// Uses @octokit/webhooks directly (not @octokit/app's wrapper) to avoid
// the OAuth dependency. Per official GitHub docs:
// https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
const webhookMiddleware = createNodeMiddleware(app.webhooks, {
  path: "/api/github/webhooks",
});

// Readiness flag -- starts false until async startup checks pass.
// Set to false again during shutdown to stop accepting new work.
let isReady = false;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    // Liveness: is the process alive? (no external deps)
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.url === "/readyz") {
    // Readiness: should we receive traffic?
    // In non-inline mode, also check Valkey health (FM-7).
    const valkeyOk = config.agentJobMode === "inline" || isValkeyHealthy();
    const ready = isReady && valkeyOk;
    res
      .writeHead(ready ? 200 : 503, { "Content-Type": "text/plain" })
      .end(ready ? "ready" : "not ready");
    return;
  }

  // Reject non-health traffic until startup checks (including DB migrations) finish.
  if (!isReady) {
    res.writeHead(503, { "Content-Type": "text/plain" }).end("not ready");
    return;
  }

  // Dev-only test endpoint: simulate a webhook event without HMAC verification.
  // Builds a BotContext with a mock Octokit and skipTrackingComments: true,
  // then feeds it into the normal processRequest() pipeline.
  if (req.url === "/api/test/webhook" && req.method === "POST") {
    if (config.nodeEnv === "production") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    void handleTestWebhook(req, res);
    return;
  }

  void webhookMiddleware(req, res);
});

server.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});

/**
 * Dev-only test webhook handler. Parses a JSON body, builds a BotContext with
 * a mock Octokit (no real GitHub API calls), sets skipTrackingComments: true,
 * and feeds it into processRequest() to exercise the full orchestrator → daemon flow.
 */
async function handleTestWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { createChildLogger } = await import("./logger");
  const { processRequest } = await import("./webhook/router");

  try {
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", reject);
    });

    const payload = JSON.parse(body) as {
      owner?: string;
      repo?: string;
      entityNumber?: number;
      isPR?: boolean;
      triggerBody?: string;
      eventName?: string;
      dryRun?: boolean;
    };

    const owner = payload.owner ?? "chrisleekr";
    const repo = payload.repo ?? "github-app-playground";
    const entityNumber = payload.entityNumber ?? 1;
    const isPR = payload.isPR ?? false;
    const triggerBody =
      payload.triggerBody ?? `${config.triggerPhrase} what files are in this repo?`;
    const dryRun = payload.dryRun ?? true;
    const eventName = (payload.eventName ?? "issue_comment") as BotContext["eventName"];
    const deliveryId = `test-${randomUUID()}`;

    // Mock Octokit that logs instead of calling GitHub API.
    // Only used by the router path (isAlreadyProcessed, concurrency comment).
    // The daemon creates its own real Octokit from the installation token.
    const mockOctokit = buildMockOctokit();

    const log = createChildLogger({
      deliveryId,
      owner,
      repo,
      entityNumber,
    });

    const ctx: BotContext = {
      owner,
      repo,
      entityNumber,
      isPR,
      eventName,
      triggerUsername: "test-user",
      triggerTimestamp: new Date().toISOString(),
      triggerBody,
      commentId: -1,
      deliveryId,
      labels: [],
      skipTrackingComments: true,
      dryRun,
      defaultBranch: "main",
      octokit: mockOctokit,
      log,
    };

    logger.info(
      { deliveryId, owner, repo, entityNumber, isPR, dryRun },
      "[test-webhook] Dispatching",
    );

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true, deliveryId }));

    processRequest(ctx).catch((err: unknown) => {
      log.error({ err }, "[test-webhook] processRequest failed");
    });
  } catch (err) {
    logger.error({ err }, "[test-webhook] Failed to parse request");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
  }
}

/**
 * Async startup checks. Runs after the HTTP server is listening so that the
 * process does not silently fail mid-request on a missing script or stale file.
 *
 * 1. Verify MCP server scripts are accessible (access() with F_OK).
 *    These scripts are spawned on every request; a missing file causes a cryptic
 *    runtime error deep in the pipeline rather than a clear startup failure.
 * 2. Sweep stale credential helper scripts (*.cred.sh) left behind by a
 *    previous pod lifetime that was SIGKILL-ed mid-checkout.
 */
async function runStartupChecks(): Promise<void> {
  // Use process.cwd() (always the project root, /app in Docker) so the path matches
  // how registry.ts spawns these servers — CWD-relative dist/mcp/servers/*.js.
  // import.meta.dir would resolve to src/ in dev and dist/ in prod, breaking one or the other.
  const mcpScripts = [
    join(process.cwd(), "dist/mcp/servers/comment.js"),
    join(process.cwd(), "dist/mcp/servers/inline-comment.js"),
  ];

  for (const scriptPath of mcpScripts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await access(scriptPath, constants.F_OK);
      logger.info({ scriptPath }, "MCP script accessible");
    } catch {
      logger.error({ scriptPath }, "MCP script not accessible — cannot start");
      process.exit(1);
    }
  }

  // *.cred.sh files accumulate in cloneBaseDir when the pod is SIGKILL-ed mid-checkout.
  // Remove files older than 1 hour to avoid leaking installation tokens across restarts.
  const STALE_CRED_TTL_MS = 60 * 60 * 1000;
  const staleCutoff = Date.now() - STALE_CRED_TTL_MS;

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await mkdir(config.cloneBaseDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const entries = await readdir(config.cloneBaseDir);
    const credFiles = entries.filter((f) => f.endsWith(".cred.sh"));

    for (const credFile of credFiles) {
      const fullPath = join(config.cloneBaseDir, credFile);
      try {
        // eslint-disable-next-line no-await-in-loop, security/detect-non-literal-fs-filename
        const { mtimeMs } = await stat(fullPath);
        if (mtimeMs < staleCutoff) {
          // eslint-disable-next-line no-await-in-loop -- fullPath is join()-constructed, not user input
          await rm(fullPath, { force: true });
          logger.info({ credFile }, "Removed stale credential helper script");
        }
      } catch {
        // Non-fatal: file may have been removed concurrently
      }
    }
  } catch {
    // Non-fatal: cloneBaseDir may not exist yet on a fresh pod
  }

  const db = getDb();
  if (db !== null) {
    await runMigrations(db);
    logger.info("Database migrations completed");

    // Recover stale executions from previous server lifetime (FM-4).
    // Runs AFTER migrations, BEFORE WebSocket server accepts connections.
    await recoverStaleExecutions(db);
  }

  if (config.agentJobMode !== "inline") {
    getValkeyClient();
    startWebSocketServer();
    logger.info({ wsPort: config.wsPort }, "Orchestrator WebSocket server started");
  }

  isReady = true;
  logger.info("Startup checks passed, server is ready");
}

void runStartupChecks().catch((err: unknown) => {
  logger.error({ err }, "Startup checks failed unexpectedly");
  process.exit(1);
});

/**
 * Graceful shutdown handler.
 * Sets readiness to false, then closes the server (waits for in-flight requests).
 * In-flight review cleanup callbacks (checkoutRepo) will run in their finally blocks.
 */
function shutdown(signal: string): void {
  logger.info({ signal }, "Received shutdown signal");
  isReady = false;

  server.close(() => {
    void (async (): Promise<void> => {
      try {
        stopWebSocketServer();
        closeValkey();
        await closeDb();
        logger.info("Server closed, exiting");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Failed to close resources during shutdown");
        process.exit(1);
      }
    })();
  });

  // Force exit after terminationGracePeriodSeconds if server.close hangs
  setTimeout(() => {
    logger.warn("Forced exit after timeout");
    process.exit(1);
  }, 290_000); // 10s below K8s default terminationGracePeriodSeconds (300s)
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

/**
 * Build a Proxy-based mock Octokit for the test webhook endpoint.
 * Intercepts all `rest.*.*()` calls and `auth()`, logging instead of hitting GitHub.
 */
function buildMockOctokit(): BotContext["octokit"] {
  type MockApiMethod = (...args: unknown[]) => Promise<{ data: unknown[] }>;

  const methodProxy = new Proxy({} as Record<string, MockApiMethod>, {
    get(_t, method: string): MockApiMethod {
      return (...args: unknown[]): Promise<{ data: unknown[] }> => {
        logger.info(
          { method, args: JSON.stringify(args).slice(0, 200) },
          "[test-webhook] Mock Octokit call",
        );
        return Promise.resolve({ data: [] });
      };
    },
  });

  const restProxy = new Proxy({} as Record<string, typeof methodProxy>, {
    get(): typeof methodProxy {
      return methodProxy;
    },
  });

  return {
    rest: restProxy,
    auth: (): Promise<{ token: string }> => Promise.resolve({ token: "mock-test-token" }),
  } as unknown as BotContext["octokit"];
}
