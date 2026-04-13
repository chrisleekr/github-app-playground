import { resolveMcpServers } from "../mcp/registry";
import type { BotContext, EnrichedBotContext, ExecutionResult } from "../types";
import { retryWithBackoff } from "../utils/retry";
import { checkoutRepo } from "./checkout";
import { executeAgent } from "./executor";
import { fetchGitHubData } from "./fetcher";
import { buildPrompt, resolveAllowedTools } from "./prompt-builder";
import { createTrackingComment, finalizeTrackingComment } from "./tracking-comment";

/**
 * Build the options object passed to `finalizeTrackingComment` on success.
 *
 * Exists because `exactOptionalPropertyTypes` forbids assigning `undefined` to
 * optional properties — we have to omit them instead. Extracted so the two
 * conditional branches don't count against runInlinePipeline's cyclomatic
 * complexity budget.
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
 * Inline processing pipeline — executes the full Claude Agent SDK workflow.
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
export async function runInlinePipeline(ctx: BotContext): Promise<void> {
  let trackingCommentId: number | undefined;

  try {
    // Step 1: Create tracking comment ("Working...")
    trackingCommentId = await retryWithBackoff(() => createTrackingComment(ctx), {
      maxAttempts: 3,
      initialDelayMs: 1000,
      log: ctx.log,
    });
    // Capture as const so TypeScript can narrow it inside arrow-function closures below.
    const resolvedTrackingCommentId = trackingCommentId;

    // Step 2: Get an installation token for API calls and git clone
    // The octokit instance on ctx is already authenticated for this installation,
    // but we need a raw token for git clone auth URL.
    // Use octokit's auth to get the installation access token.
    const { token: installationToken } = (await ctx.octokit.auth({
      type: "installation",
    })) as { token: string };

    // Step 3: Fetch PR/issue data via GraphQL
    const data = await retryWithBackoff(() => fetchGitHubData(ctx), {
      maxAttempts: 3,
      initialDelayMs: 2000,
      log: ctx.log,
    });

    // Build an enriched context with branch data resolved from GraphQL.
    // Creates a new object instead of mutating ctx to avoid hidden temporal dependencies.
    const enrichedCtx: EnrichedBotContext = {
      ...ctx,
      headBranch: data.headBranch ?? ctx.headBranch ?? ctx.defaultBranch,
      baseBranch: data.baseBranch ?? ctx.baseBranch ?? ctx.defaultBranch,
    };

    // Step 4: Build the full prompt
    const prompt = buildPrompt(enrichedCtx, data, resolvedTrackingCommentId);

    // Step 5: Clone repo to temp directory
    const { workDir, cleanup } = await checkoutRepo(enrichedCtx, installationToken);

    try {
      // Step 6: Resolve MCP servers for this context
      const mcpServers = resolveMcpServers(
        enrichedCtx,
        resolvedTrackingCommentId,
        installationToken,
      );

      // Step 7: Resolve allowed tools
      const allowedTools = resolveAllowedTools(enrichedCtx);

      // Step 8: Execute Claude Agent SDK
      const result = await executeAgent(enrichedCtx, prompt, mcpServers, workDir, allowedTools);

      // Step 9: Finalize tracking comment with results.
      // Post-success bookkeeping errors must NOT mark the execution as failed —
      // the agent work already completed successfully at this point.
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

      enrichedCtx.log.info(
        {
          success: result.success,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
        },
        "Request processing completed",
      );
    } finally {
      // Step 10: Cleanup temp directory (always, even on error).
      // Wrapped to avoid masking the original error if cleanup fails.
      try {
        await cleanup();
      } catch (cleanupError) {
        ctx.log.error({ err: cleanupError }, "Failed to cleanup temp directory");
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Log the full error server-side only — do not expose internal details in the comment.
    ctx.log.error({ err }, "Request processing failed");

    // Update tracking comment with a generic user-facing message to avoid leaking
    // internal error details (paths, API keys, server addresses) to GitHub contributors.
    if (trackingCommentId !== undefined) {
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
  }
}
