/**
 * Idempotent marker-comment upsert for scoped commands (FR-031 / FR-033 /
 * FR-034). A scoped command posts at most one marked comment per
 * `(intent, target_number)`; re-triggers update the existing comment in
 * place via the marker scan so the conversation does not accumulate
 * duplicates.
 *
 * Marker grammar: `<!-- bot:<verb>:<number> -->` — distinct from the
 * shepherding tracking-comment marker (`<!-- ship-intent:<id> -->`)
 * so cross-feature comment recycling is impossible.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { safePostToGitHub } from "../../../utils/github-output-guard";

export interface ScopedMarker {
  readonly verb: string;
  readonly number: number;
}

export function buildScopedMarker(marker: ScopedMarker): string {
  return `<!-- bot:${marker.verb}:${marker.number} -->`;
}

export interface FindCommentByMarkerInput {
  readonly octokit: Pick<Octokit, "rest" | "paginate">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly marker: string;
}

/**
 * Scan all comments on the issue/PR for the marker. GitHub paginates
 * comment lists at 100/page; we use the standard `octokit.paginate`
 * iterator so multi-page conversations are handled without manual
 * cursor bookkeeping. Returns the matching comment id or `null` if
 * no comment carries the marker.
 */
export async function findCommentByMarker(input: FindCommentByMarkerInput): Promise<number | null> {
  const iter = input.octokit.paginate.iterator(input.octokit.rest.issues.listComments, {
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
    per_page: 100,
  });
  for await (const page of iter) {
    for (const comment of page.data) {
      const body = comment.body ?? "";
      if (body.includes(input.marker)) return comment.id;
    }
  }
  return null;
}

export interface UpsertMarkerCommentInput {
  readonly octokit: Pick<Octokit, "rest" | "paginate">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly marker: string;
  readonly body: string;
  readonly source: "agent" | "system";
  readonly log: Logger;
  readonly deliveryId?: string;
}

/**
 * If a comment carrying the marker already exists, PATCH its body;
 * otherwise POST a new comment. The caller is responsible for embedding
 * the marker inside `body` (it MUST appear verbatim somewhere in the
 * rendered Markdown — typically the trailing line as an HTML comment).
 * Returns the comment id of the upserted comment.
 *
 * Routed through `safePostToGitHub` so any secrets that surfaced into the
 * agent-rendered body are stripped before reaching GitHub.
 */
export async function upsertMarkerComment(input: UpsertMarkerCommentInput): Promise<number> {
  const existing = await findCommentByMarker({
    octokit: input.octokit,
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
    marker: input.marker,
  });
  if (existing !== null) {
    const guarded = await safePostToGitHub({
      body: input.body,
      source: input.source,
      callsite: "ship.scoped.marker-comment.update",
      log: input.log,
      deliveryId: input.deliveryId,
      post: (cleanBody) =>
        input.octokit.rest.issues.updateComment({
          owner: input.owner,
          repo: input.repo,
          comment_id: existing,
          body: cleanBody,
        }),
    });
    if (!guarded.posted) {
      throw new Error(
        `ship.scoped.marker-comment.update: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    return existing;
  }
  const guarded = await safePostToGitHub({
    body: input.body,
    source: input.source,
    callsite: "ship.scoped.marker-comment.create",
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
      `ship.scoped.marker-comment.create: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
    );
  }
  return guarded.result.data.id;
}
