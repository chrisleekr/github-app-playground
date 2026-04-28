/**
 * Webhook reactor (T022) — early-wakes intents whose state may have
 * changed. Per `contracts/webhook-event-subscriptions.md` §"Reactor flow":
 * each event handler invokes `fanOut(event)` AFTER returning 200-OK.
 *
 * Idempotent under duplicate delivery (GitHub retries):
 *   - matching read is read-only
 *   - `wake_at = now()` on already-now is a no-op
 *   - `ZADD` with the same score is a no-op
 *   - state transitions check current `status` first
 */

import type { RedisClient, SQL } from "bun";

import { requireDb } from "../../db";
import { logger } from "../../logger";
import { transitionToTerminal } from "./intent";

export const TICKLE_KEY = "ship:tickle";
export const CANCEL_KEY_PREFIX = "ship:cancel:";

interface MatchedIntent {
  readonly id: string;
  readonly status: "active" | "paused";
  readonly target_head_sha: string;
}

async function findIntentsForPr(
  installation_id: number,
  owner: string,
  repo: string,
  pr_number: number,
  sql: SQL,
): Promise<MatchedIntent[]> {
  return await sql`
    SELECT id, status, target_head_sha
      FROM ship_intents
     WHERE installation_id = ${installation_id}
       AND owner = ${owner}
       AND repo = ${repo}
       AND pr_number = ${pr_number}
       AND status IN ('active', 'paused')
  `;
}

async function earlyWake(
  intent_id: string,
  sql: SQL,
  valkey: Pick<RedisClient, "send"> | null,
): Promise<void> {
  await sql`
    UPDATE ship_continuations SET wake_at = now() WHERE intent_id = ${intent_id}
  `;
  if (valkey !== null) {
    await valkey.send("ZADD", [TICKLE_KEY, "0", intent_id]);
  }
}

export interface ReactorDeps {
  readonly sql?: SQL;
  readonly valkey?: Pick<RedisClient, "send"> | null;
  readonly botAppLogin: string;
}

export interface PullRequestSynchronizeEvent {
  readonly type: "pull_request.synchronize";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly head_author_login: string | null;
}

export interface PullRequestClosedEvent {
  readonly type: "pull_request.closed";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly merged: boolean;
}

export interface ReviewSubmittedEvent {
  readonly type: "pull_request_review.submitted";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
}

export interface ReviewCommentEvent {
  readonly type: "pull_request_review_comment";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
}

export interface CheckRunCompletedEvent {
  readonly type: "check_run.completed";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_numbers: readonly number[];
}

export interface CheckSuiteCompletedEvent {
  readonly type: "check_suite.completed";
  readonly installation_id: number;
  readonly owner: string;
  readonly repo: string;
  readonly pr_numbers: readonly number[];
}

export type ReactorEvent =
  | PullRequestSynchronizeEvent
  | PullRequestClosedEvent
  | ReviewSubmittedEvent
  | ReviewCommentEvent
  | CheckRunCompletedEvent
  | CheckSuiteCompletedEvent;

export async function fanOut(event: ReactorEvent, deps: ReactorDeps): Promise<void> {
  const sql = deps.sql ?? requireDb();
  const valkey = deps.valkey ?? null;

  const prNumbers: readonly number[] =
    event.type === "check_run.completed" || event.type === "check_suite.completed"
      ? event.pr_numbers
      : [event.pr_number];

  for (const pr_number of prNumbers) {
    const intents = await findIntentsForPr(
      event.installation_id,
      event.owner,
      event.repo,
      pr_number,
      sql,
    );
    if (intents.length === 0) continue;

    for (const intent of intents) {
      try {
        await processIntentEvent(event, intent, { sql, valkey, botAppLogin: deps.botAppLogin });
      } catch (err) {
        // Isolate per-intent failures — one error must not abort the rest
        // of the fan-out batch (could be many intents across many PRs).
        logger.error(
          {
            event: "ship.reactor.fanout_error",
            intent_id: intent.id,
            pr_number,
            trigger: event.type,
            err: String(err),
          },
          "ship reactor failed for intent — continuing with remaining intents",
        );
      }
    }
  }
}

interface ProcessDeps {
  readonly sql: SQL;
  readonly valkey: Pick<RedisClient, "send"> | null;
  readonly botAppLogin: string;
}

async function processIntentEvent(
  event: ReactorEvent,
  intent: { readonly id: string; readonly target_head_sha: string; readonly status: string },
  { sql, valkey, botAppLogin }: ProcessDeps,
): Promise<void> {
  switch (event.type) {
    case "pull_request.synchronize":
      await handleSynchronize(event, intent, { sql, valkey, botAppLogin });
      return;
    case "pull_request.closed": {
      const terminal = event.merged ? "merged_externally" : "pr_closed";
      await transitionToTerminal(intent.id, terminal, null, sql);
      logger.info(
        {
          event: "ship.reactor.fanout",
          intent_id: intent.id,
          trigger: event.type,
          outcome: terminal,
        },
        "ship reactor terminated intent on PR close",
      );
      return;
    }
    case "pull_request_review.submitted":
    case "pull_request_review_comment":
    case "check_run.completed":
    case "check_suite.completed":
      // Signal-only events on a paused intent are no-ops per
      // bot-commands.md §"Reactor behaviour while paused".
      if (intent.status === "paused") return;
      await earlyWake(intent.id, sql, valkey);
      return;
  }
}

async function handleSynchronize(
  event: PullRequestSynchronizeEvent,
  intent: { readonly id: string; readonly target_head_sha: string },
  { sql, valkey, botAppLogin }: ProcessDeps,
): Promise<void> {
  const isBot = event.head_author_login === botAppLogin;
  if (!isBot && event.head_sha !== intent.target_head_sha) {
    await transitionToTerminal(intent.id, "human_took_over", "manual-push-detected", sql);
    logger.info(
      {
        event: "ship.reactor.fanout",
        intent_id: intent.id,
        trigger: event.type,
        outcome: "human_took_over",
      },
      "ship reactor terminated intent on foreign push",
    );
    return;
  }
  await sql`UPDATE ship_intents SET target_head_sha = ${event.head_sha}, updated_at = now() WHERE id = ${intent.id}`;
  await earlyWake(intent.id, sql, valkey);
}
