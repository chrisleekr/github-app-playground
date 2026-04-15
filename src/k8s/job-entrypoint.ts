/**
 * Isolated-job entrypoint (T020).
 *
 * Runs INSIDE the K8s pod spawned by `spawnIsolatedJob`. Reads the
 * AGENT_CONTEXT_B64 env var (set by the spawner), reconstructs a minimal
 * BotContext, invokes the inline pipeline against it, and exits 0 / 1.
 *
 * Note: this entrypoint executes in a different process than the webhook
 * server. It can NOT rely on:
 *   - the in-memory orchestrator concurrency counter
 *   - the webhook server's logger (it has its own pino instance)
 *   - any module-level state from the server process
 *
 * Side effects it owns end-to-end:
 *   - posts tracking-comment updates via Octokit
 *   - writes / updates the executions row in Postgres (when DATABASE_URL is set)
 *   - exits with the appropriate status code so K8s marks the Job
 *     succeeded / failed
 */

import { App } from "octokit";

import { config } from "../config";
import { runInlinePipeline } from "../core/inline-pipeline";
import { logger } from "../logger";
import type { BotContext } from "../types";

/** Coerce an unknown decoded field to a string with a default; never crashes. */
function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerce an unknown decoded field to a finite number with a default. */
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Decode the BotContext envelope the spawner injected via env. Returns null
 * on any malformed input — the entrypoint logs and exits 1 rather than
 * crashing on parse, so K8s records a clean failure with the log link.
 */
function decodeContext(b64: string | undefined): Record<string, unknown> | null {
  if (b64 === undefined || b64 === "") return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const log = logger.child({ component: "isolated-job-entrypoint" });

  const decoded = decodeContext(process.env["AGENT_CONTEXT_B64"]);
  if (decoded === null) {
    log.error("AGENT_CONTEXT_B64 env var missing or unparseable; aborting");
    process.exit(1);
  }

  const owner = asString(decoded["owner"], "");
  const repo = asString(decoded["repo"], "");
  const entityNumber = asNumber(decoded["entityNumber"], 0);
  const installationId = asNumber(decoded["installationId"], 0);
  if (owner === "" || repo === "" || entityNumber === 0 || installationId === 0) {
    log.error(
      { owner, repo, entityNumber, installationId },
      "decoded BotContext missing required fields; aborting",
    );
    process.exit(1);
  }

  // Re-mint an Octokit instance from the GitHub App credentials. The
  // spawner does NOT forward the installation token (those are short-lived
  // and the server-side grant might not still be valid by the time the pod
  // starts). The pod re-issues against its own App credentials, which the
  // server-side AGENT_JOB_MODE config makes available via env.
  if (
    config.appId === undefined ||
    config.privateKey === undefined ||
    config.webhookSecret === undefined
  ) {
    log.error("GITHUB_APP_ID / PRIVATE_KEY / WEBHOOK_SECRET missing; aborting");
    process.exit(1);
  }
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    webhookSecret: config.webhookSecret,
  });
  const octokit = await app.getInstallationOctokit(installationId);

  const deliveryId = asString(decoded["deliveryId"], "");
  const eventNameRaw = asString(decoded["eventName"], "issue_comment");
  const eventName: BotContext["eventName"] =
    eventNameRaw === "pull_request_review_comment" ? eventNameRaw : "issue_comment";

  const ctx: BotContext = {
    owner,
    repo,
    entityNumber,
    isPR: decoded["isPR"] === true,
    eventName,
    triggerUsername: asString(decoded["triggerUsername"], "unknown"),
    triggerTimestamp: asString(decoded["triggerTimestamp"], new Date().toISOString()),
    triggerBody: asString(decoded["triggerBody"], ""),
    commentId: asNumber(decoded["commentId"], 0),
    deliveryId,
    defaultBranch: asString(decoded["defaultBranch"], "main"),
    labels: Array.isArray(decoded["labels"])
      ? (decoded["labels"] as unknown[]).filter((l): l is string => typeof l === "string")
      : [],
    octokit,
    log: log.child({ deliveryId }),
  };

  log.info(
    { deliveryId: ctx.deliveryId, owner, repo, entityNumber },
    "isolated-job entrypoint starting inline pipeline",
  );

  try {
    await runInlinePipeline(ctx);
    log.info("isolated-job pipeline completed");
    process.exit(0);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "isolated-job pipeline failed",
    );
    process.exit(1);
  }
}

// Top-level await is fine in Bun's ESM runtime; the file is invoked via
// `bun run src/k8s/job-entrypoint.ts` from the K8s Job spec.
await main();
