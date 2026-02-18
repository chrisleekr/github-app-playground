import { config } from "../config";
import { checkoutRepo } from "../core/checkout";
import { executeAgent } from "../core/executor";
import { fetchGitHubData } from "../core/fetcher";
import { buildPrompt, resolveAllowedTools } from "../core/prompt-builder";
import {
  createTrackingComment,
  finalizeTrackingComment,
  isAlreadyProcessed,
} from "../core/tracking-comment";
import { resolveMcpServers } from "../mcp/registry";
import type { BotContext, EnrichedBotContext } from "../types";
import { retryWithBackoff } from "../utils/retry";

/**
 * In-memory idempotency guard using X-GitHub-Delivery header.
 * Prevents duplicate processing on webhook retries.
 *
 * Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
 */
const processed = new Map<string, number>();

/**
 * Active concurrent request counter.
 * Bounded by config.maxConcurrentRequests (MAX_CONCURRENT_REQUESTS env var, default 3).
 * Guards against API budget exhaustion and resource saturation from simultaneous triggers.
 */
let activeCount = 0;

// Periodic cleanup of stale entries (1 hour TTL).
// unref() prevents this timer from keeping the process alive during shutdown.
// See: https://nodejs.org/api/timers.html#timeoutunref
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [id, ts] of processed) {
    if (ts < cutoff) processed.delete(id);
  }
}, IDEMPOTENCY_TTL_MS);
cleanupInterval.unref();

/**
 * Main async processing pipeline.
 * Called fire-and-forget from event handlers after the webhook has responded 200 OK.
 *
 * Pipeline:
 * 1. Idempotency check
 * 2. Create tracking comment
 * 3. Fetch PR/issue data via GraphQL
 * 4. Build prompt
 * 5. Clone repo to temp directory
 * 6. Resolve MCP servers
 * 7. Execute Claude Agent SDK
 * 8. Finalize tracking comment
 * 9. Cleanup temp directory
 */
export async function processRequest(ctx: BotContext): Promise<void> {
  // Fast-path idempotency: in-memory check (current process lifetime only)
  if (processed.has(ctx.deliveryId)) {
    ctx.log.info("Skipping duplicate delivery (in-memory)");
    return;
  }

  // Reserve the delivery ID in-memory BEFORE the async durable check.
  // This closes the race window where two near-simultaneous retries with the same
  // deliveryId could both pass the has() check, then both pass isAlreadyProcessed()
  // (before either creates the tracking comment), and proceed to duplicate work.
  // Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
  processed.set(ctx.deliveryId, Date.now());

  // Durable idempotency: check if we already posted a tracking comment for this
  // delivery. Survives pod restarts; catches GitHub retries after OOM / rolling updates.
  if (await isAlreadyProcessed(ctx)) {
    ctx.log.info("Skipping duplicate delivery (durable marker found)");
    // Key stays in map — delivery IS processed; subsequent retries hit the fast path.
    return;
  }

  // Concurrency guard: reject when too many Claude executions are active to
  // prevent Anthropic API budget exhaustion and pod resource saturation.
  if (activeCount >= config.maxConcurrentRequests) {
    ctx.log.warn(
      { activeCount, limit: config.maxConcurrentRequests },
      "Concurrency limit reached, rejecting request",
    );
    // Inform the user so they know to re-trigger rather than wait silently.
    // Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
    try {
      await ctx.octokit.rest.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.entityNumber,
        body: `**${config.triggerPhrase}** is at capacity (${activeCount}/${config.maxConcurrentRequests} concurrent requests active). Please re-trigger in a moment.`,
      });
    } catch (commentError) {
      ctx.log.error({ err: commentError }, "Failed to post capacity comment");
    }
    return;
  }
  activeCount++;

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

      // Step 9: Finalize tracking comment with results
      // Build opts conditionally (exactOptionalPropertyTypes forbids explicit undefined)
      const finalOpts: { success: boolean; durationMs?: number; costUsd?: number } = {
        success: result.success,
      };
      if (result.durationMs !== undefined) {
        finalOpts.durationMs = result.durationMs;
      }
      if (result.costUsd !== undefined) {
        finalOpts.costUsd = result.costUsd;
      }
      await retryWithBackoff(
        () => finalizeTrackingComment(enrichedCtx, resolvedTrackingCommentId, finalOpts),
        {
          maxAttempts: 3,
          initialDelayMs: 1000,
          log: enrichedCtx.log,
        },
      );

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
      // Step 10: Cleanup temp directory (always, even on error)
      await cleanup();
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Log the full error server-side only — do not expose internal details in the comment.
    ctx.log.error({ err }, "Request processing failed");

    // Update tracking comment with a generic user-facing message to avoid leaking
    // internal error details (paths, API keys, server addresses) to GitHub contributors.
    if (trackingCommentId !== undefined) {
      try {
        await finalizeTrackingComment(ctx, trackingCommentId, {
          success: false,
          error: "An internal error occurred. Check server logs for details.",
        });
      } catch (commentError) {
        ctx.log.error({ err: commentError }, "Failed to update tracking comment with error");
      }
    }
  } finally {
    // Always decrement so the next request can enter the pipeline
    activeCount--;
  }
}
