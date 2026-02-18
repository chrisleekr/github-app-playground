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
import { logger } from "./logger";
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
const app = new App({
  appId: config.appId,
  privateKey: config.privateKey,
  webhooks: { secret: config.webhookSecret },
});

// Register webhook event handlers
// The octokit instance and delivery ID are provided by the webhook framework
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

// Global webhook error handler
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
  // Health endpoints (outside webhook middleware)
  if (req.url === "/healthz") {
    // Liveness: is the process alive? (no external deps)
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.url === "/readyz") {
    // Readiness: should we receive traffic?
    res
      .writeHead(isReady ? 200 : 503, { "Content-Type": "text/plain" })
      .end(isReady ? "ready" : "shutting down");
    return;
  }

  // All other routes go through webhook middleware
  void webhookMiddleware(req, res);
});

server.listen(config.port, () => {
  logger.info({ port: config.port }, "Server started");
});

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
  // --- MCP script accessibility checks ---
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

  // --- Stale credential helper sweep ---
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
    logger.info("Server closed, exiting");
    process.exit(0);
  });

  // Force exit after terminationGracePeriodSeconds if server.close hangs
  setTimeout(() => {
    logger.warn("Forced exit after timeout");
    process.exit(1);
  }, 290_000); // 290 s force-exit timeout; allows in-flight requests to finish
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
