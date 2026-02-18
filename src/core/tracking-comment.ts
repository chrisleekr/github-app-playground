import { config } from "../config";
import type { BotContext } from "../types";

/** Spinner HTML used by claude-code-action for "in progress" state */
const SPINNER_HTML = `<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />`;

/**
 * Build the hidden HTML marker used for durable idempotency.
 * Embedded in the tracking comment body so the marker survives pod restarts
 * and can be detected on webhook retries.
 */
export function deliveryMarker(deliveryId: string): string {
  return `<!-- delivery:${deliveryId} -->`;
}

/**
 * Check if a bot comment for this delivery already exists.
 * Used as a durable idempotency check that survives pod restarts, complementing
 * the in-memory processed Map which only covers the current process lifetime.
 *
 * Per: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
 */
export async function isAlreadyProcessed(ctx: BotContext): Promise<boolean> {
  const { octokit, owner, repo, entityNumber, deliveryId } = ctx;

  const marker = deliveryMarker(deliveryId);

  // Fetch with direction:"desc" so the most recent comments (including the bot's tracking
  // comment) appear in the first page. On busy PRs with >100 comments the tracking comment
  // is appended last, so descending order ensures it is not missed by the 100-item limit.
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: entityNumber,
    per_page: 100,
    direction: "desc",
  });

  return comments.data.some((c) => c.body?.includes(marker) === true);
}

/**
 * Create the initial tracking comment ("Working...").
 * Returns the comment ID for future updates.
 *
 * Ported from claude-code-action's comment creation logic
 */
export async function createTrackingComment(ctx: BotContext): Promise<number> {
  const { octokit, owner, repo, entityNumber, log } = ctx;

  // Embed the deliveryId marker for durable idempotency — survives pod restarts.
  // The in-memory processed Map in router.ts is the fast-path check;
  // this marker is the durable fallback.
  const body = `${deliveryMarker(ctx.deliveryId)}\n${SPINNER_HTML} **${config.triggerPhrase}** is working on this...\n\n_Analyzing your request..._`;

  const result = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: entityNumber,
    body,
  });

  log.info({ trackingCommentId: result.data.id }, "Created tracking comment");

  return result.data.id;
}

/**
 * Update the tracking comment with new content.
 * Used by the MCP comment server and the pipeline itself.
 *
 * Always uses the issues API because the tracking comment is created via
 * issues.createComment (even for review comment events). Issue comment IDs
 * are not valid in the pulls review comments namespace.
 * See: https://docs.github.com/en/rest/issues/comments
 */
export async function updateTrackingComment(
  ctx: BotContext,
  trackingCommentId: number,
  body: string,
): Promise<void> {
  const { octokit, owner, repo } = ctx;

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: trackingCommentId,
    body,
  });
}

/**
 * Finalize the tracking comment with completion status.
 * Called after Claude finishes or errors.
 */
export async function finalizeTrackingComment(
  ctx: BotContext,
  trackingCommentId: number,
  opts: {
    success: boolean;
    durationMs?: number;
    costUsd?: number;
    error?: string;
  },
): Promise<void> {
  const { success, durationMs, costUsd, error } = opts;

  let header: string;
  if (success) {
    const duration = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : "unknown";
    const cost = costUsd !== undefined ? `$${costUsd.toFixed(4)}` : "";
    header = `**${config.triggerPhrase} finished @${ctx.triggerUsername}'s task** (${duration}${cost !== "" ? `, ${cost}` : ""})`;
  } else {
    header = `**${config.triggerPhrase} encountered an error** while processing @${ctx.triggerUsername}'s request`;
  }

  // Read current comment body to preserve progress content.
  // Always use issues API -- tracking comment is created via issues.createComment.
  let existingBody = "";
  try {
    const comment = await ctx.octokit.rest.issues.getComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: trackingCommentId,
    });
    existingBody = comment.data.body ?? "";
  } catch {
    // If we can't read the comment, just use the header
  }

  // Remove spinner from existing body. SPINNER_HTML is a module constant, not user input;
  // all special regex characters are escaped before constructing the pattern.
  const escapedSpinner = SPINNER_HTML.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // eslint-disable-next-line security/detect-non-literal-regexp
  const spinnerRegex = new RegExp(escapedSpinner, "g");
  const cleanedBody = existingBody.replace(spinnerRegex, "");

  const errorSection = error !== undefined && error !== "" ? `\n\n---\n**Error:** ${error}` : "";

  // Re-prepend the delivery marker so the durable idempotency check survives even if
  // Claude's update_claude_comment call (which runs sanitizeContent) previously stripped it.
  const finalBody = `${deliveryMarker(ctx.deliveryId)}\n${header}\n\n---\n${cleanedBody}${errorSection}`;

  await updateTrackingComment(ctx, trackingCommentId, finalBody);
}
