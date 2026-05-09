/**
 * Typed `Bun.sql` helpers for the `comment_cache` and `target_cache`
 * tables introduced in migration `011_conversation_cache.sql`. The
 * conversation-store is a write-through projection of GitHub state —
 * GitHub remains the source of truth.
 *
 * Write-through happens in the webhook handlers
 * (`src/webhook/events/issue-comment.ts`,
 * `src/webhook/events/review-comment.ts`,
 * `src/webhook/events/issues.ts`,
 * `src/webhook/events/pull-request.ts`) on every `created` / `edited`
 * / `deleted` action, BEFORE any chat-thread dispatch so the agent
 * sees the freshest body on the very turn the edit triggered.
 *
 * The chat-thread executor reads the cache via `loadConversation()`.
 * Cache miss (first-time interaction with a target since deploy)
 * triggers a one-shot Octokit fetch + write-through inside the
 * caller; this module only owns the DB side.
 */

import type { Octokit } from "octokit";

import { requireDb } from "..";

// ─── Row types ────────────────────────────────────────────────────────────────

export interface CommentCacheRow {
  readonly owner: string;
  readonly repo: string;
  readonly target_type: "issue" | "pr";
  readonly target_number: number;
  readonly comment_id: number;
  readonly surface: "issue-comment" | "review-comment";
  readonly in_reply_to_id: number | null;
  readonly author_login: string;
  readonly author_type: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly diff_hunk: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
  readonly fetched_at: Date;
}

export interface TargetCacheRow {
  readonly owner: string;
  readonly repo: string;
  readonly target_type: "issue" | "pr";
  readonly target_number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly author_login: string;
  readonly is_draft: boolean | null;
  readonly base_ref: string | null;
  readonly head_ref: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly fetched_at: Date;
}

// ─── Comment cache writes ─────────────────────────────────────────────────────

export interface UpsertCommentInput {
  readonly owner: string;
  readonly repo: string;
  readonly targetType: "issue" | "pr";
  readonly targetNumber: number;
  readonly commentId: number;
  readonly surface: "issue-comment" | "review-comment";
  readonly inReplyToId: number | null;
  readonly authorLogin: string;
  readonly authorType: string;
  readonly body: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly diffHunk: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Idempotent upsert. Used for both `created` and `edited` webhook
 * actions — the ON CONFLICT UPDATE preserves `created_at` and
 * `deleted_at`, and refreshes `updated_at` from GitHub's clock so
 * out-of-order edit deliveries resolve to the latest payload.
 */
export async function upsertComment(input: UpsertCommentInput): Promise<void> {
  const db = requireDb();
  await db`
    INSERT INTO comment_cache (
      owner, repo, target_type, target_number, comment_id, surface,
      in_reply_to_id, author_login, author_type, body,
      path, line, diff_hunk, created_at, updated_at, fetched_at
    ) VALUES (
      ${input.owner}, ${input.repo}, ${input.targetType}, ${input.targetNumber},
      ${input.commentId}, ${input.surface},
      ${input.inReplyToId}, ${input.authorLogin}, ${input.authorType}, ${input.body},
      ${input.path}, ${input.line}, ${input.diffHunk},
      ${input.createdAt}, ${input.updatedAt}, now()
    )
    ON CONFLICT (owner, repo, comment_id) DO UPDATE SET
      body = EXCLUDED.body,
      updated_at = GREATEST(comment_cache.updated_at, EXCLUDED.updated_at),
      fetched_at = now()
  `;
}

/**
 * Soft-delete on `deleted` webhook action. Read paths filter
 * deleted_at IS NOT NULL out of the conversation but the row stays
 * for audit.
 */
export async function softDeleteComment(input: {
  readonly owner: string;
  readonly repo: string;
  readonly commentId: number;
}): Promise<void> {
  const db = requireDb();
  await db`
    UPDATE comment_cache
    SET deleted_at = now()
    WHERE owner = ${input.owner} AND repo = ${input.repo} AND comment_id = ${input.commentId}
  `;
}

// ─── Target cache writes ──────────────────────────────────────────────────────

export interface UpsertTargetInput {
  readonly owner: string;
  readonly repo: string;
  readonly targetType: "issue" | "pr";
  readonly targetNumber: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly authorLogin: string;
  readonly isDraft: boolean | null;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function upsertTarget(input: UpsertTargetInput): Promise<void> {
  const db = requireDb();
  await db`
    INSERT INTO target_cache (
      owner, repo, target_type, target_number,
      title, body, state, author_login,
      is_draft, base_ref, head_ref,
      created_at, updated_at, fetched_at
    ) VALUES (
      ${input.owner}, ${input.repo}, ${input.targetType}, ${input.targetNumber},
      ${input.title}, ${input.body}, ${input.state}, ${input.authorLogin},
      ${input.isDraft}, ${input.baseRef}, ${input.headRef},
      ${input.createdAt}, ${input.updatedAt}, now()
    )
    ON CONFLICT (owner, repo, target_type, target_number) DO UPDATE SET
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      state = EXCLUDED.state,
      is_draft = EXCLUDED.is_draft,
      base_ref = EXCLUDED.base_ref,
      head_ref = EXCLUDED.head_ref,
      updated_at = GREATEST(target_cache.updated_at, EXCLUDED.updated_at),
      fetched_at = now()
  `;
}

// ─── Conversation read path ───────────────────────────────────────────────────

export interface LoadConversationInput {
  readonly owner: string;
  readonly repo: string;
  readonly targetType: "issue" | "pr";
  readonly targetNumber: number;
  /**
   * When provided, scope the conversation to a specific review-comment
   * thread (the top-level comment_id + all replies via in_reply_to_id).
   * When undefined, return ALL comments on the target (issue/PR
   * top-level discussion).
   */
  readonly threadId?: number;
}

export interface ConversationSnapshot {
  readonly target: TargetCacheRow | null;
  readonly comments: readonly CommentCacheRow[];
}

/**
 * Read the cached conversation for a target. Returns rows ordered by
 * `created_at ASC` (chronological). Soft-deleted rows are filtered.
 *
 * Cache miss is silent — the caller checks `target === null` /
 * `comments.length === 0` and decides whether to backfill from
 * Octokit (see `backfillFromGitHub` below).
 */
export async function loadConversation(
  input: LoadConversationInput,
): Promise<ConversationSnapshot> {
  const db = requireDb();
  const targetRows = await db<TargetCacheRow[]>`
    SELECT * FROM target_cache
    WHERE owner = ${input.owner} AND repo = ${input.repo}
      AND target_type = ${input.targetType} AND target_number = ${input.targetNumber}
    LIMIT 1
  `;
  const target = targetRows[0] ?? null;

  let comments: CommentCacheRow[];
  if (input.threadId === undefined) {
    comments = await db<CommentCacheRow[]>`
      SELECT * FROM comment_cache
      WHERE owner = ${input.owner} AND repo = ${input.repo}
        AND target_type = ${input.targetType} AND target_number = ${input.targetNumber}
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
  } else {
    // Thread-scoped: include the top-level comment AND every reply
    // pointing at it.
    const threadId = input.threadId;
    comments = await db<CommentCacheRow[]>`
      SELECT * FROM comment_cache
      WHERE owner = ${input.owner} AND repo = ${input.repo}
        AND deleted_at IS NULL
        AND (comment_id = ${threadId} OR in_reply_to_id = ${threadId})
      ORDER BY created_at ASC
    `;
  }
  return { target, comments };
}

// ─── Cache miss backfill ──────────────────────────────────────────────────────

export interface BackfillInput {
  /** Full Octokit needed because backfill walks paginated comment endpoints. */
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly targetType: "issue" | "pr";
  readonly targetNumber: number;
}

/**
 * Cold-start backfill: fetch the target body + all comments from
 * GitHub once and write through. Subsequent turns hit the cache.
 *
 * Best-effort — partial failures (e.g., review-comments listing for an
 * issue, which is invalid) are swallowed at this level. The downstream
 * loadConversation simply returns whatever made it into the cache.
 */
export async function backfillFromGitHub(input: BackfillInput): Promise<void> {
  // Target body
  if (input.targetType === "issue") {
    const issue = await input.octokit.rest.issues.get({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.targetNumber,
    });
    await upsertTarget({
      owner: input.owner,
      repo: input.repo,
      targetType: "issue",
      targetNumber: input.targetNumber,
      title: issue.data.title,
      body: issue.data.body ?? "",
      state: issue.data.state,
      authorLogin: issue.data.user?.login ?? "",
      isDraft: null,
      baseRef: null,
      headRef: null,
      createdAt: new Date(issue.data.created_at),
      updatedAt: new Date(issue.data.updated_at),
    });
  } else {
    const pr = await input.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.targetNumber,
    });
    await upsertTarget({
      owner: input.owner,
      repo: input.repo,
      targetType: "pr",
      targetNumber: input.targetNumber,
      title: pr.data.title,
      body: pr.data.body ?? "",
      state: pr.data.merged ? "merged" : pr.data.state,
      authorLogin: pr.data.user?.login ?? "",
      isDraft: pr.data.draft ?? false,
      baseRef: pr.data.base.ref,
      headRef: pr.data.head.ref,
      createdAt: new Date(pr.data.created_at),
      updatedAt: new Date(pr.data.updated_at),
    });
  }

  // Issue / PR top-level comments — same REST endpoint for both.
  try {
    const comments = await input.octokit.paginate(input.octokit.rest.issues.listComments, {
      owner: input.owner,
      repo: input.repo,
      issue_number: input.targetNumber,
      per_page: 100,
    });
    for (const c of comments) {
      await upsertComment({
        owner: input.owner,
        repo: input.repo,
        targetType: input.targetType,
        targetNumber: input.targetNumber,
        commentId: c.id,
        surface: "issue-comment",
        inReplyToId: null,
        authorLogin: c.user?.login ?? "",
        authorType: c.user?.type ?? "User",
        body: c.body ?? "",
        path: null,
        line: null,
        diffHunk: null,
        createdAt: new Date(c.created_at),
        updatedAt: new Date(c.updated_at),
      });
    }
  } catch {
    // Issue/PR conversation listing should always succeed; swallow
    // here so a permission glitch doesn't break the backfill — the
    // chat-thread executor still gets the target body.
  }

  // Review comments — PR only.
  if (input.targetType === "pr") {
    try {
      const reviewComments = await input.octokit.paginate(
        input.octokit.rest.pulls.listReviewComments,
        {
          owner: input.owner,
          repo: input.repo,
          pull_number: input.targetNumber,
          per_page: 100,
        },
      );
      for (const c of reviewComments) {
        await upsertComment({
          owner: input.owner,
          repo: input.repo,
          targetType: "pr",
          targetNumber: input.targetNumber,
          commentId: c.id,
          surface: "review-comment",
          inReplyToId: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
          authorLogin: c.user?.login ?? "",
          authorType: c.user?.type ?? "User",
          body: c.body ?? "",
          path: c.path,
          line: typeof c.line === "number" ? c.line : null,
          diffHunk: c.diff_hunk ?? null,
          createdAt: new Date(c.created_at),
          updatedAt: new Date(c.updated_at),
        });
      }
    } catch {
      // No review-comments endpoint failure should bubble; the cache
      // will repopulate as future webhooks arrive.
    }
  }
}
