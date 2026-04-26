import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveMcpServers } from "../mcp/registry";
import type { BotContext, EnrichedBotContext, ExecutionResult } from "../types";
import { retryWithBackoff } from "../utils/retry";
import { checkoutRepo } from "./checkout";
import { executeAgent } from "./executor";
import { fetchGitHubData } from "./fetcher";
import { buildPrompt, resolveAllowedTools } from "./prompt-builder";
import { createTrackingComment, finalizeTrackingComment } from "./tracking-comment";

/** Read .daemon-actions.json written by the repo-memory MCP server during execution. */
function readDaemonActionsFile(
  workDir: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): { learnings: { category: string; content: string }[]; deletions: string[] } {
  try {
    const actionsPath = join(workDir, ".daemon-actions.json");
    const exists = existsSync(actionsPath); // eslint-disable-line security/detect-non-literal-fs-filename
    log.info({ actionsPath, exists }, "Checking for daemon actions file");
    if (exists) {
      const actions = JSON.parse(readFileSync(actionsPath, "utf-8")) as {
        type: string;
        category?: string;
        content?: string;
        id?: string;
      }[];
      const learnings = actions
        .filter(
          (a): a is { type: "save"; category: string; content: string } =>
            a.type === "save" && typeof a.category === "string" && typeof a.content === "string",
        )
        .map(({ category, content }) => ({ category, content }));
      const deletions = actions
        .filter(
          (a): a is { type: "delete"; id: string } =>
            a.type === "delete" && typeof a.id === "string",
        )
        .map((a) => a.id);
      log.info({ learnings: learnings.length, deletions: deletions.length }, "Read daemon actions");
      return { learnings, deletions };
    }
  } catch (err) {
    log.warn({ err }, "Failed to read daemon actions file");
  }
  return { learnings: [], deletions: [] };
}

/**
 * Read agent-written report files from the workspace before cleanup runs.
 * Best-effort: missing files are silently dropped from the returned map.
 * Returns undefined when the caller didn't request anything, so the result
 * shape stays clean (no empty `capturedFiles: {}` for default callers).
 */
async function readCapturedFiles(
  workDir: string,
  basenames: readonly string[] | undefined,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<Record<string, string> | undefined> {
  if (basenames === undefined || basenames.length === 0) return undefined;
  const { readFile } = await import("node:fs/promises");
  const captured: Record<string, string> = {};
  for (const name of basenames) {
    try {
      const content = await readFile(join(workDir, name), "utf-8");
      if (content.trim().length > 0) captured[name] = content;
    } catch {
      // Missing file is expected when the agent declines to write it.
    }
  }
  log.info({ captured: Object.keys(captured) }, "Read captured workspace files");
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/**
 * Build the options object passed to `finalizeTrackingComment` on success.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to optional
 * properties — we must omit them instead. Extracted so the conditional
 * branches don't count against runPipeline's cyclomatic complexity budget.
 */
function buildFinalOpts(result: ExecutionResult): {
  success: boolean;
  durationMs?: number;
  costUsd?: number;
} {
  const opts: { success: boolean; durationMs?: number; costUsd?: number } = {
    success: result.success,
  };
  if (result.durationMs !== undefined) {
    opts.durationMs = result.durationMs;
  }
  if (result.costUsd !== undefined) {
    opts.costUsd = result.costUsd;
  }
  return opts;
}

/**
 * Optional overrides for the daemon (via `job:payload`) to honor
 * orchestrator-provided execution limits and to track the workspace path.
 */
export interface RunPipelineOverrides {
  maxTurns?: number;
  allowedTools?: string[];
  /**
   * Fires once the pipeline has cloned the repo and knows the workspace path.
   * Used by the daemon to track workDir for cancellation and SIGKILL cleanup.
   */
  onWorkDirReady?: (workDir: string) => void;
  /**
   * Basenames (e.g. "IMPLEMENT.md") for files the agent may have written to
   * the workspace. Read best-effort BEFORE cleanup — content is returned in
   * `ExecutionResult.capturedFiles`. Missing files are not errors. Used so
   * a workflow handler can include a structured agent report in its
   * tracking comment without duplicating the pipeline machinery.
   */
  captureFiles?: string[];
  /**
   * Pre-existing tracking comment id (typically created by a workflow
   * handler via `setState` before invoking the pipeline). When set, the
   * pipeline does NOT call `createTrackingComment`/`finalizeTrackingComment`
   * — the orchestrator's tracking-mirror owns the comment lifecycle, and
   * the pipeline only wires the id into the prompt + MCP server so the
   * agent can post mid-run progress via `update_claude_comment`.
   */
  trackingCommentId?: number;
  /**
   * Caller-supplied AbortSignal forwarded to `executeAgent` (and through to
   * the Claude Agent SDK's `query()` via its `abortController` option). When
   * fired, the SDK iterator is torn down, the Claude Code subprocess and MCP
   * servers exit, and the pipeline returns `success: false`. Used by the
   * daemon to make `handleJobCancel` actually terminate the agent.
   */
  signal?: AbortSignal;
}

/**
 * Write orchestrator-provided env vars as `.env` in the agent workspace so the
 * agent subprocess (cwd=workDir) can read them. Values are written verbatim —
 * callers own escaping.
 */
function writeEnvFile(
  workDir: string,
  envVars: Record<string, string> | undefined,
  log: { info: (obj: object, msg: string) => void },
): void {
  if (envVars === undefined || Object.keys(envVars).length === 0) return;
  const envContent = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- workDir is a daemon-owned temp path
  writeFileSync(join(workDir, ".env"), `${envContent}\n`);
  log.info({ keyCount: Object.keys(envVars).length }, "Wrote .env from orchestrator env vars");
}

/**
 * Claude Agent SDK execution pipeline. Every dispatched job runs through this
 * function — currently only invoked by the daemon job-executor.
 *
 * Pipeline:
 * 1. Create tracking comment ("Working...")
 * 2. Get installation token
 * 3. Fetch PR/issue data via GraphQL
 * 4. Build prompt with full context
 * 5. Clone repo to temp directory
 * 6. Resolve MCP servers and allowed tools
 * 7. Execute Claude Agent SDK
 * 8. Finalize tracking comment (success/error/cost)
 * 9. Cleanup temp directory
 */
export async function runPipeline(
  ctx: BotContext,
  overrides: RunPipelineOverrides = {},
): Promise<ExecutionResult> {
  let trackingCommentId: number | undefined;
  // When the caller (workflow handler) seeded the tracking comment, the
  // pipeline must NOT finalize it — the handler's terminal `setState` writes
  // the final body via tracking-mirror, and a pipeline finalize would
  // overwrite it with the legacy "completed" template.
  const callerOwnsTrackingComment = overrides.trackingCommentId !== undefined;

  try {
    if (callerOwnsTrackingComment) {
      trackingCommentId = overrides.trackingCommentId;
      ctx.log.info(
        { trackingCommentId },
        "Using caller-supplied tracking comment (workflow handler owns lifecycle)",
      );
    } else if (ctx.skipTrackingComments === true) {
      ctx.log.info("Skipping tracking comment (skipTrackingComments)");
    } else {
      trackingCommentId = await retryWithBackoff(() => createTrackingComment(ctx), {
        maxAttempts: 3,
        initialDelayMs: 1000,
        log: ctx.log,
      });
    }
    const resolvedTrackingCommentId = trackingCommentId;

    const { token: installationToken } = (await ctx.octokit.auth({
      type: "installation",
    })) as { token: string };

    const data = await retryWithBackoff(() => fetchGitHubData(ctx), {
      maxAttempts: 3,
      initialDelayMs: 2000,
      log: ctx.log,
    });

    const enrichedCtx: EnrichedBotContext = {
      ...ctx,
      headBranch: data.headBranch ?? ctx.headBranch ?? ctx.defaultBranch,
      baseBranch: data.baseBranch ?? ctx.baseBranch ?? ctx.defaultBranch,
    };

    const prompt = buildPrompt(enrichedCtx, data, resolvedTrackingCommentId);

    if (ctx.dryRun === true) {
      ctx.log.info(
        { promptLength: prompt.length, headBranch: enrichedCtx.headBranch },
        "Dry-run complete — skipping checkout, MCP, and Claude execution",
      );
      return { success: true, durationMs: 0, costUsd: 0, numTurns: 0, dryRun: true };
    }

    const { workDir, cleanup } = await checkoutRepo(enrichedCtx, installationToken);
    overrides.onWorkDirReady?.(workDir);

    try {
      writeEnvFile(workDir, enrichedCtx.envVars, enrichedCtx.log);

      const mcpServers = resolveMcpServers(
        enrichedCtx,
        resolvedTrackingCommentId,
        installationToken,
        {
          workDir,
          ...(enrichedCtx.repoMemory !== undefined ? { repoMemory: enrichedCtx.repoMemory } : {}),
        },
      );

      const allowedTools =
        overrides.allowedTools ?? resolveAllowedTools(enrichedCtx, enrichedCtx.daemonCapabilities);

      const result = await executeAgent({
        ctx: enrichedCtx,
        prompt,
        mcpServers,
        workDir,
        allowedTools,
        installationToken,
        ...(overrides.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
        ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
      });

      if (resolvedTrackingCommentId !== undefined && !callerOwnsTrackingComment) {
        try {
          const finalOpts = buildFinalOpts(result);
          await retryWithBackoff(
            () => finalizeTrackingComment(enrichedCtx, resolvedTrackingCommentId, finalOpts),
            {
              maxAttempts: 3,
              initialDelayMs: 1000,
              log: enrichedCtx.log,
            },
          );
        } catch (finalizeError) {
          enrichedCtx.log.error(
            { err: finalizeError },
            "Failed to finalize tracking comment after successful execution",
          );
        }
      }

      enrichedCtx.log.info(
        {
          success: result.success,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
        },
        "Request processing completed",
      );

      const daemonActions = readDaemonActionsFile(workDir, enrichedCtx.log);
      const capturedFiles = await readCapturedFiles(
        workDir,
        overrides.captureFiles,
        enrichedCtx.log,
      );

      return {
        ...result,
        ...(daemonActions.learnings.length > 0 || daemonActions.deletions.length > 0
          ? { daemonActions }
          : {}),
        ...(capturedFiles !== undefined ? { capturedFiles } : {}),
      };
    } finally {
      try {
        await cleanup();
      } catch (cleanupError) {
        ctx.log.error({ err: cleanupError }, "Failed to cleanup temp directory");
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    ctx.log.error({ err }, "Request processing failed");

    if (trackingCommentId !== undefined && !callerOwnsTrackingComment) {
      const commentId = trackingCommentId;
      try {
        await retryWithBackoff(
          () =>
            finalizeTrackingComment(ctx, commentId, {
              success: false,
              error: "An internal error occurred. Check server logs for details.",
            }),
          {
            maxAttempts: 3,
            initialDelayMs: 1000,
            log: ctx.log,
          },
        );
      } catch (commentError) {
        ctx.log.error({ err: commentError }, "Failed to update tracking comment with error");
      }
    }

    return { success: false };
  }
}
