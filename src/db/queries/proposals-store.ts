/**
 * Typed `Bun.sql` helpers for the `chat_proposals` table introduced in
 * migration `010_chat_proposals.sql`. Owns the proposal state machine:
 *
 *   awaiting --(👍 reaction)----> approved --(execute)--> executed
 *           --(reply: yes)------> approved
 *           --(reply: no)-------> declined
 *           --(replace-proposal)-> superseded
 *           --(24h elapsed)-----> expired
 *
 * Application-layer Zod schemas (ProposalKindSchema, ProposalPayload*)
 * are validated here so callers can't write a payload shape the
 * downstream executor doesn't recognise. The DB only stores the JSONB
 * blob: the type discipline lives in this module.
 */

import { z } from "zod";

import { requireDb } from "..";

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * The five canonical workflow names we're allowed to propose-and-execute
 * against. These mirror `WorkflowNameSchema` in
 * `src/workflows/registry.ts` minus `ship` (which is a composite the
 * legacy classifier already routes via `bot:ship`). Including all six
 * here for completeness; the chat-thread executor decides which subset
 * is conversationally proposeable.
 */
export const PROPOSAL_WORKFLOW_NAMES = [
  "triage",
  "plan",
  "implement",
  "review",
  "resolve",
  "ship",
] as const;
export type ProposalWorkflowName = (typeof PROPOSAL_WORKFLOW_NAMES)[number];

/**
 * The discriminator stored in `proposal_kind`. Mirrored verbatim into
 * the DB; the column is a free-form TEXT but the application layer
 * enforces it.
 */
export const ProposalKindSchema = z.union([
  z.literal("action:create-issue"),
  z.literal("action:resolve-thread"),
  z.literal("action:add-label"),
  z.literal("action:cross-link"),
  ...PROPOSAL_WORKFLOW_NAMES.map((w) => z.literal(`workflow:${w}` as const)),
]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

// Per-kind payload schemas. Each is the shape the downstream executor
// receives at approval time; the LLM does NOT re-author these at
// approval time, preserving the "human consented to the exact thing"
// invariant.

export const CreateIssuePayloadSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(60_000),
  labels: z.array(z.string().min(1).max(64)).max(16).default([]),
});
export type CreateIssuePayload = z.infer<typeof CreateIssuePayloadSchema>;

export const ResolveThreadPayloadSchema = z.object({
  thread_id: z.string().min(1),
});
export type ResolveThreadPayload = z.infer<typeof ResolveThreadPayloadSchema>;

export const AddLabelPayloadSchema = z.object({
  labels: z.array(z.string().min(1).max(64)).min(1).max(16),
});
export type AddLabelPayload = z.infer<typeof AddLabelPayloadSchema>;

export const CrossLinkPayloadSchema = z.object({
  related_url: z.url(),
  reason: z.string().min(1).max(500),
});
export type CrossLinkPayload = z.infer<typeof CrossLinkPayloadSchema>;

export const WorkflowProposalPayloadSchema = z.object({
  workflow: z.enum(PROPOSAL_WORKFLOW_NAMES),
  rationale: z.string().min(1).max(500),
  /**
   * The original comment id that triggered the conversation. Used by
   * the approval-time executor to set up the workflow_runs row's
   * trigger_comment_id correctly.
   */
  trigger_comment_id: z.number().int().positive(),
  trigger_event_type: z.enum(["issue_comment", "pull_request_review_comment"]),
});
export type WorkflowProposalPayload = z.infer<typeof WorkflowProposalPayloadSchema>;

export const ProposalStatusSchema = z.enum([
  "awaiting",
  "approved",
  "executed",
  "declined",
  "expired",
  "superseded",
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

// ─── Row types ────────────────────────────────────────────────────────────────

export interface ChatProposalRow {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly target_type: "issue" | "pr";
  readonly target_number: number;
  readonly thread_id: string | null;
  readonly proposal_comment_id: number;
  readonly proposal_kind: ProposalKind;
  readonly payload: unknown;
  readonly asker_login: string;
  readonly approver_login: string | null;
  readonly status: ProposalStatus;
  readonly expires_at: Date;
  readonly cumulative_cost_usd: string;
  readonly turn_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

// ─── Inserts ──────────────────────────────────────────────────────────────────

export interface InsertProposalInput {
  readonly owner: string;
  readonly repo: string;
  readonly targetType: "issue" | "pr";
  readonly targetNumber: number;
  readonly threadId: string | null;
  readonly proposalCommentId: number;
  readonly proposalKind: ProposalKind;
  readonly payload: unknown;
  readonly askerLogin: string;
  readonly ttlHours: number;
}

/**
 * Insert a new awaiting proposal. The caller is expected to have
 * already superseded any prior awaiting proposal for the same
 * `(owner, repo, target_number, thread_id)` scope: calling this on a
 * scope that already has an awaiting row will throw a unique-violation
 * (Postgres code 23505 on `idx_chat_proposals_one_awaiting`). That's
 * intentional: it surfaces a logic bug in the executor rather than
 * silently leaving two proposals in flight.
 */
export async function insertProposal(input: InsertProposalInput): Promise<ChatProposalRow> {
  const db = requireDb();
  ProposalKindSchema.parse(input.proposalKind);
  const expiresAt = new Date(Date.now() + Math.max(1, input.ttlHours) * 3_600_000);
  const rows = await db<ChatProposalRow[]>`
    INSERT INTO chat_proposals (
      owner, repo, target_type, target_number, thread_id,
      proposal_comment_id, proposal_kind, payload,
      asker_login, status, expires_at
    ) VALUES (
      ${input.owner}, ${input.repo}, ${input.targetType}, ${input.targetNumber},
      ${input.threadId},
      ${input.proposalCommentId}, ${input.proposalKind}, ${input.payload}::jsonb,
      ${input.askerLogin}, 'awaiting', ${expiresAt}
    )
    RETURNING *
  `;
  if (rows[0] === undefined) {
    throw new Error("insertProposal: RETURNING * came back empty");
  }
  return rows[0];
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function findAwaitingByTarget(input: {
  readonly owner: string;
  readonly repo: string;
  readonly targetNumber: number;
  readonly threadId?: string | null;
}): Promise<ChatProposalRow | null> {
  const db = requireDb();
  // Scope match: when threadId is provided, match exactly (NULL or
  // value); when undefined, return any awaiting row for the target
  // (caller is asking "is there ANY pending proposal here").
  if (input.threadId === undefined) {
    const rows = await db<ChatProposalRow[]>`
      SELECT * FROM chat_proposals
      WHERE owner = ${input.owner}
        AND repo = ${input.repo}
        AND target_number = ${input.targetNumber}
        AND status = 'awaiting'
        AND expires_at > now()
      LIMIT 1
    `;
    return rows[0] ?? null;
  }
  const threadId = input.threadId;
  const rows = await db<ChatProposalRow[]>`
    SELECT * FROM chat_proposals
    WHERE owner = ${input.owner}
      AND repo = ${input.repo}
      AND target_number = ${input.targetNumber}
      AND COALESCE(thread_id, '') = COALESCE(${threadId}, '')
      AND status = 'awaiting'
      AND expires_at > now()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function findById(id: string): Promise<ChatProposalRow | null> {
  const db = requireDb();
  const rows = await db<ChatProposalRow[]>`
    SELECT * FROM chat_proposals WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listAwaitingForPolling(limit: number): Promise<ChatProposalRow[]> {
  const db = requireDb();
  return db<ChatProposalRow[]>`
    SELECT * FROM chat_proposals
    WHERE status = 'awaiting' AND expires_at > now()
    ORDER BY created_at ASC
    LIMIT ${Math.max(1, limit)}
  `;
}

// ─── State transitions ────────────────────────────────────────────────────────

/**
 * Atomically transition `awaiting` → `approved`. Guarded against
 * losing a race with another approval signal: the WHERE clause
 * requires `status = 'awaiting'` so a second approval-by-comment
 * arriving after the reaction-poll already approved is a no-op
 * (returns null).
 */
export async function approve(input: {
  readonly id: string;
  readonly approverLogin: string;
}): Promise<ChatProposalRow | null> {
  const db = requireDb();
  const rows = await db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET status = 'approved', approver_login = ${input.approverLogin}
    WHERE id = ${input.id} AND status = 'awaiting' AND expires_at > now()
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function markExecuted(id: string): Promise<ChatProposalRow | null> {
  const db = requireDb();
  const rows = await db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET status = 'executed'
    WHERE id = ${id} AND status = 'approved'
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function decline(input: {
  readonly id: string;
  readonly approverLogin: string;
}): Promise<ChatProposalRow | null> {
  const db = requireDb();
  const rows = await db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET status = 'declined', approver_login = ${input.approverLogin}
    WHERE id = ${input.id} AND status = 'awaiting'
    RETURNING *
  `;
  return rows[0] ?? null;
}

/**
 * Bulk supersede all awaiting proposals on a `(target, thread)` scope.
 * Called when a new ask arrives and we want to reset the proposal
 * state. Returns the rows that were transitioned (typically 0 or 1).
 */
export async function supersedeOnTarget(input: {
  readonly owner: string;
  readonly repo: string;
  readonly targetNumber: number;
  readonly threadId: string | null;
}): Promise<ChatProposalRow[]> {
  const db = requireDb();
  return db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET status = 'superseded'
    WHERE owner = ${input.owner}
      AND repo = ${input.repo}
      AND target_number = ${input.targetNumber}
      AND COALESCE(thread_id, '') = COALESCE(${input.threadId}, '')
      AND status = 'awaiting'
    RETURNING *
  `;
}

/**
 * Sweep expired awaiting proposals. Run by the proposal-poller on
 * every tick after the reaction scan; bounded by the partial index
 * `idx_chat_proposals_expires_at`.
 */
export async function expireStaleAwaiting(): Promise<ChatProposalRow[]> {
  const db = requireDb();
  return db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET status = 'expired'
    WHERE status = 'awaiting' AND expires_at <= now()
    RETURNING *
  `;
}

// ─── Cost / turn accounting ───────────────────────────────────────────────────

/**
 * Increment turn_count on the proposal row. Used by chat-thread to
 * enforce CHAT_THREAD_MAX_TURNS. Cost tracking is not yet wired,
 * follow-up will plumb token counts from the LLM adaptor.
 */
export async function bumpTurn(input: {
  readonly id: string;
  readonly turnDelta: number;
}): Promise<ChatProposalRow | null> {
  const db = requireDb();
  const rows = await db<ChatProposalRow[]>`
    UPDATE chat_proposals
    SET turn_count = turn_count + ${input.turnDelta}
    WHERE id = ${input.id}
    RETURNING *
  `;
  return rows[0] ?? null;
}
