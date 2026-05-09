/**
 * Proposal poller — periodic scanner for awaiting `chat_proposals`
 * rows that the user has approved by reacting 👍 on the bot's
 * proposal comment.
 *
 * Why this exists: GitHub does NOT fire webhook events for reactions
 * on issue / PR / review comments. The chat-thread executor's primary
 * approval signal is therefore unobservable in real-time. Two paths
 * close that gap:
 *
 *   1. Piggyback poll — webhook handlers for the same target call
 *      `runProposalPollOnce()` after dispatch (cheap, latency-free).
 *      Implemented inline in the webhook handlers.
 *
 *   2. Periodic scanner (THIS FILE) — handles the case where the user
 *      reacts but never posts another comment. Runs every
 *      `CHAT_THREAD_POLLER_INTERVAL_MS` (default 90s; clamped to
 *      [60s, 600s]); bounded by `idx_chat_proposals_pending_target`
 *      so cost is O(open proposals) — zero work when nothing is
 *      awaiting.
 *
 * Lifecycle: started by `src/app.ts` on boot when `DATABASE_URL` is
 * configured (gated through `getDb()`); stopped on SIGTERM via the
 * returned `stop()` function. Inline-mode deployments (no DB) skip
 * the poller entirely.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { getDb } from "../db";
import {
  approve as approveProposal,
  expireStaleAwaiting,
  listAwaitingForPolling,
} from "../db/queries/proposals-store";
import { logger as rootLogger } from "../logger";

export interface ProposalPollerDeps {
  /**
   * Resolve an installation-scoped Octokit for the given installation.
   * The poller uses this to list reactions on the proposal comment.
   * Caller (src/app.ts) provides this so the poller stays decoupled
   * from the GitHub App auth path.
   */
  readonly resolveOctokit: (installationId: number) => Promise<Octokit>;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly log?: Logger;
  /**
   * Map (owner, repo) → installation_id so the poller can mint the
   * right Octokit for each proposal's repository. The chat_proposals
   * row does NOT carry installation_id — the caller (app.ts) supplies
   * a resolver that goes through whatever installation lookup the
   * server already maintains.
   */
  readonly resolveInstallationId: (input: {
    readonly owner: string;
    readonly repo: string;
  }) => Promise<number | null>;
}

export interface ProposalPollerHandle {
  readonly stop: () => void;
}

const DEFAULT_INTERVAL_MS = 90_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 600_000;
const DEFAULT_BATCH_SIZE = 50;

/**
 * Start the periodic proposal poller. No-op when no DB is configured.
 * Returns a handle whose `stop()` cancels the timer.
 */
export function startProposalPoller(deps: ProposalPollerDeps): ProposalPollerHandle {
  const log = (deps.log ?? rootLogger).child({ component: "proposal-poller" });

  if (getDb() === null) {
    log.info("proposal-poller: DATABASE_URL not configured — skipping");
    return {
      stop: () => {
        // No-op: poller never started.
      },
    };
  }

  const intervalMs = clampInterval(deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);

  const tick = async (): Promise<void> => {
    try {
      const expired = await expireStaleAwaiting();
      if (expired.length > 0) {
        log.info({ expired: expired.length }, "proposal-poller: expired stale awaiting rows");
      }
      await runProposalPollOnce({
        resolveOctokit: deps.resolveOctokit,
        resolveInstallationId: deps.resolveInstallationId,
        batchSize,
        log,
      });
    } catch (err) {
      log.error({ err }, "proposal-poller: tick threw");
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  log.info({ intervalMs, batchSize }, "proposal-poller: started");
  return {
    stop: () => {
      clearInterval(handle);
      log.info("proposal-poller: stopped");
    },
  };
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, ms));
}

// ─── One-shot scan ────────────────────────────────────────────────────────────

export interface RunProposalPollOnceInput {
  readonly resolveOctokit: (installationId: number) => Promise<Octokit>;
  readonly resolveInstallationId: (input: {
    readonly owner: string;
    readonly repo: string;
  }) => Promise<number | null>;
  readonly batchSize?: number;
  readonly log: Logger;
}

/**
 * One-shot reaction-poll. Used by both the periodic scanner AND the
 * webhook piggyback path (call this after dispatching a webhook for
 * the same target — most common UX is "user reacts then types
 * something" which fires the next webhook, and we want to flip the
 * proposal status during that cycle).
 *
 * Returns the number of rows transitioned to `approved`.
 */
export async function runProposalPollOnce(
  input: RunProposalPollOnceInput,
): Promise<{ approved: number; checked: number }> {
  const batch = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const rows = await listAwaitingForPolling(batch);
  let approved = 0;
  for (const row of rows) {
    try {
      const installationId = await input.resolveInstallationId({
        owner: row.owner,
        repo: row.repo,
      });
      if (installationId === null) {
        input.log.debug(
          { proposalId: row.id, owner: row.owner, repo: row.repo },
          "proposal-poller: no installation_id for repo — skipping",
        );
        continue;
      }
      const octokit = await input.resolveOctokit(installationId);
      const approver = await findThumbsUpApprover({
        octokit,
        owner: row.owner,
        repo: row.repo,
        commentId: row.proposal_comment_id,
        surface: row.thread_id !== null ? "review-comment" : "issue-comment",
      });
      if (approver === null) continue;
      // Don't honour the asker reacting to their own proposal as a
      // safety nuance. Wait — actually, the asker IS the right person
      // to approve. Leaving the check loose: any non-Bot user counts.
      const result = await approveProposal({ id: row.id, approverLogin: approver });
      if (result !== null) {
        approved += 1;
        input.log.info(
          { proposalId: row.id, approver },
          "proposal-poller: proposal approved by reaction",
        );
      }
    } catch (err) {
      input.log.warn(
        { err, proposalId: row.id },
        "proposal-poller: failed to poll one proposal — skipping",
      );
    }
  }
  return { approved, checked: rows.length };
}

// ─── Reaction lookup ──────────────────────────────────────────────────────────

interface FindThumbsUpInput {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly commentId: number;
  readonly surface: "issue-comment" | "review-comment";
}

/**
 * List 👍 (`+1`) reactions on the proposal comment; return the first
 * non-Bot user's login, or null. The proposal-store's `approve`
 * transition is idempotent on `status='awaiting'` so racing approvals
 * are safe.
 */
async function findThumbsUpApprover(input: FindThumbsUpInput): Promise<string | null> {
  // Both endpoints take `comment_id` and a `content` filter. Paginate
  // because reactions can include the bot itself, which we filter out.
  const reactions =
    input.surface === "review-comment"
      ? await input.octokit.paginate(input.octokit.rest.reactions.listForPullRequestReviewComment, {
          owner: input.owner,
          repo: input.repo,
          comment_id: input.commentId,
          content: "+1",
          per_page: 100,
        })
      : await input.octokit.paginate(input.octokit.rest.reactions.listForIssueComment, {
          owner: input.owner,
          repo: input.repo,
          comment_id: input.commentId,
          content: "+1",
          per_page: 100,
        });
  for (const r of reactions) {
    const user = r.user;
    if (user === null) continue;
    if (user.type === "Bot") continue;
    return user.login;
  }
  return null;
}
