/**
 * Tracking-comment lifecycle for `bot:ship` sessions (FR-006, R10).
 * One canonical comment per intent, identified by an HTML-comment
 * marker so the comment id can be re-discovered after a cached id
 * 404s (e.g. comment was deleted by a maintainer mid-session).
 *
 * Marker format: `<!-- ship-intent:{intent_id} -->` — both endpoints
 * (writer + scanner) use exactly this string so cross-version drift
 * cannot strand a session.
 */

import type { SQL } from "bun";
import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { safePostToGitHub } from "../../utils/github-output-guard";

export const SHIP_INTENT_MARKER_PREFIX = "<!-- ship-intent:";

export function buildIntentMarker(intent_id: string): string {
  return `${SHIP_INTENT_MARKER_PREFIX}${intent_id} -->`;
}

export interface CreateTrackingCommentInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly body: string;
  readonly log: Logger;
  readonly deliveryId?: string;
}

/**
 * POST a new comment and return its id. Caller is responsible for
 * persisting the id back onto `ship_intents.tracking_comment_id`.
 * Routed through `safePostToGitHub` so any secrets that surfaced into
 * the rendered body are stripped before reaching GitHub.
 */
export async function createTrackingComment(input: CreateTrackingCommentInput): Promise<number> {
  const guarded = await safePostToGitHub({
    body: input.body,
    source: "system",
    callsite: "ship.tracking-comment.create",
    log: input.log,
    deliveryId: input.deliveryId,
    post: (cleanBody) =>
      input.octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issue_number,
        body: cleanBody,
      }),
  });
  if (!guarded.posted || guarded.result === undefined) {
    throw new Error(
      `ship.tracking-comment.create: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
    );
  }
  return guarded.result.data.id;
}

export interface UpdateTrackingCommentInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly comment_id: number;
  readonly body: string;
  readonly log: Logger;
  readonly deliveryId?: string;
}

export async function updateTrackingComment(input: UpdateTrackingCommentInput): Promise<void> {
  await safePostToGitHub({
    body: input.body,
    source: "system",
    callsite: "ship.tracking-comment.update",
    log: input.log,
    deliveryId: input.deliveryId,
    post: (cleanBody) =>
      input.octokit.rest.issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: input.comment_id,
        body: cleanBody,
      }),
  });
}

/**
 * Fall-back marker scan when a cached `tracking_comment_id` 404s.
 * Returns the first matching comment id, or `null` when no comment
 * carries the marker. Uses paginated REST listing — at most 300
 * comments are scanned (3 × default 100 page size); intents whose
 * tracking comment lives further down the timeline are extremely rare.
 */
export async function findTrackingCommentByMarker(input: {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly intent_id: string;
}): Promise<number | null> {
  const marker = buildIntentMarker(input.intent_id);
  for (let page = 1; page <= 3; page += 1) {
    const result = await input.octokit.rest.issues.listComments({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.issue_number,
      per_page: 100,
      page,
    });
    for (const comment of result.data) {
      if (typeof comment.body === "string" && comment.body.includes(marker)) {
        return comment.id;
      }
    }
    if (result.data.length < 100) break;
  }
  return null;
}

export async function persistTrackingCommentId(
  intent_id: string,
  comment_id: number,
  sql: SQL = requireDb(),
): Promise<void> {
  await sql`
    UPDATE ship_intents
       SET tracking_comment_id = ${comment_id}, updated_at = now()
     WHERE id = ${intent_id}
  `;
}

export interface TrackingCommentRender {
  readonly intent_id: string;
  readonly trigger_login: string;
  readonly deadline_at: Date;
  readonly phase: "probing" | "fixing" | "replying" | "waiting" | "terminal";
  readonly last_action: string;
  readonly iteration_n: number;
  readonly spent_usd: number;
  readonly terminal_state?: string;
  readonly blocker_category?: string;
  readonly flake_annotation?: string;
  /** T050 (FR-006): the action the bot is queued to take next. */
  readonly next_queued_action?: string;
  /** T050: timestamp of this render — defaults to now. */
  readonly last_updated_at?: Date;
}

export function renderTrackingComment(input: TrackingCommentRender): string {
  const lastUpdated = input.last_updated_at ?? new Date();
  const lines: string[] = [];
  lines.push(buildIntentMarker(input.intent_id));
  lines.push(`### \`bot:ship\` shepherding session`);
  lines.push("");
  lines.push(`- **Session id:** \`${input.intent_id}\``);
  lines.push(`- **Triggered by:** @${input.trigger_login}`);
  lines.push(`- **Deadline:** ${input.deadline_at.toISOString()}`);
  lines.push(`- **Phase:** ${input.phase}`);
  lines.push(`- **Last action:** ${input.last_action}`);
  if (input.next_queued_action !== undefined && input.next_queued_action !== "") {
    lines.push(`- **Next queued action:** ${input.next_queued_action}`);
  }
  lines.push(`- **Iteration:** ${input.iteration_n}`);
  lines.push(`- **USD spent:** $${input.spent_usd.toFixed(4)}`);
  lines.push(`- **Last updated:** ${lastUpdated.toISOString()}`);
  if (input.terminal_state !== undefined) {
    lines.push(`- **Terminal state:** \`${input.terminal_state}\``);
  }
  if (input.blocker_category !== undefined) {
    lines.push(`- **Blocker:** \`${input.blocker_category}\``);
  }
  if (input.flake_annotation !== undefined && input.flake_annotation !== "") {
    lines.push("");
    lines.push("**Observed flakes:**");
    lines.push(input.flake_annotation);
  }
  lines.push("");
  lines.push(
    `_To stop: comment \`${config.triggerPhrase} bot:abort-ship\` (terminal) or \`${config.triggerPhrase} bot:stop\` (resumable)._`,
  );
  return lines.join("\n");
}
