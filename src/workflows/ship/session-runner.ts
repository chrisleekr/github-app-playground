/**
 * `runShipFromCommand` (T028) — entry point for the v2 ship lifecycle
 * driven by a `CanonicalCommand` from `trigger-router.routeTrigger(...)`.
 * Distinct from the legacy `WorkflowHandler` exported by
 * `src/workflows/handlers/ship.ts`, which drives the workflow_runs
 * composite (triage → plan → implement → review → resolve) lifecycle.
 *
 * Re-exported from `ship.ts` for spec-locator parity with T028 path
 * descriptions.
 *
 * Implements:
 *   (a) accept `CanonicalCommand`
 *   (b) `eligibility.checkEligibility` BEFORE any DB write
 *   (c) `intent.createIntent` with already-in-progress reply
 *   (e) terminal action when probe verdict is `ready`:
 *        (1) `markPullRequestReadyForReview` (gated on `isDraft`)
 *        (2) update tracking comment to terminal state
 *        (3) transition `ship_intents.status` to `ready_awaiting_human_merge`
 *
 * Deferred to follow-ups (intentionally scoped out of this slice):
 *   (d) continuation loop swap (US2 — fix iteration lives there)
 *   - label self-removal after acting (FR-026a; needs `label_name` carried
 *     in CanonicalCommand)
 *   - reply-as-thread (currently posts a fresh issue comment)
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { logger as rootLogger } from "../../logger";
import type { CanonicalCommand } from "../../shared/ship-types";
import { checkpointCancelled } from "./abort";
import { checkEligibility } from "./eligibility";
import { createIntent, transitionToTerminal } from "./intent";
import { runProbe } from "./probe";
import {
  buildIntentMarker,
  createTrackingComment,
  persistTrackingCommentId,
  renderTrackingComment,
  updateTrackingComment,
} from "./tracking-comment";

const MARK_READY_FOR_REVIEW_MUTATION = `
  mutation MarkReady($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest { id isDraft }
    }
  }
`;

interface MarkReadyResponse {
  readonly markPullRequestReadyForReview: {
    readonly pullRequest: { readonly id: string; readonly isDraft: boolean };
  };
}

export interface RunShipFromCommandInput {
  readonly command: CanonicalCommand;
  readonly octokit: Octokit;
  readonly log?: Logger;
}

export async function runShipFromCommand(input: RunShipFromCommandInput): Promise<void> {
  const { command, octokit } = input;
  const log = (input.log ?? rootLogger).child({
    component: "ship.session-runner",
    intent: command.intent,
    surface: command.surface,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    principal_login: command.principal_login,
  });

  // (b) Eligibility first — never create state for ineligible PRs.
  const verdict = await checkEligibility({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    triggeringUserLogin: command.principal_login,
  });
  if (!verdict.eligible) {
    log.info(
      { event: "ship.ineligible", reason: verdict.reason, surface: command.surface },
      "ship trigger rejected — eligibility failed",
    );
    await postRefusal(octokit, command, verdict.message, log);
    return;
  }

  // Probe BEFORE creating the intent so we can carry the canonical
  // base/head SHAs into the row (avoids a second GraphQL call). The
  // probe also gives us the merge-readiness verdict for the terminal
  // shortcut below.
  const probe = await runProbe({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    botAppLogin: config.botAppLogin,
    botPushedShas: new Set<string>(),
  });
  const pr = probe.response.repository?.pullRequest;
  if (pr === undefined || pr === null) {
    log.warn(
      { event: "ship.probe_pr_missing" },
      "probe returned no pullRequest — aborting (eligibility verified moments ago)",
    );
    return;
  }

  const deadlineMs = clampDeadline(command.deadline_ms);
  const deadlineAt = new Date(Date.now() + deadlineMs);

  // (c) Create intent — partial unique index rejects re-trigger.
  const result = await createIntent({
    installation_id: command.pr.installation_id,
    owner: command.pr.owner,
    repo: command.pr.repo,
    pr_number: command.pr.number,
    target_base_sha: pr.baseRefOid,
    target_head_sha: pr.headRefOid,
    deadline_at: deadlineAt,
    created_by_user: command.principal_login,
    tracking_comment_marker: buildIntentMarker(""), // patched below once intent_id is known
  });
  if (!result.ok) {
    log.info(
      { event: "ship.already_in_progress", existing_intent_id: result.existing.id },
      "ship trigger rejected — session already in progress",
    );
    await postReply(
      octokit,
      command,
      `\`bot:ship\` is already in progress for this PR (intent \`${result.existing.id}\`). ` +
        `To stop it, comment \`${config.triggerPhrase} bot:abort-ship\`.`,
      log,
    );
    return;
  }

  const intent = result.intent;
  const sql = requireDb();

  // Patch the marker now that the intent_id is known. The placeholder is
  // never consumed by code in-flight (it only matters for marker-based
  // recovery scans), but persisting the canonical value keeps the row
  // schema-honest for any future re-discovery logic.
  const canonicalMarker = buildIntentMarker(intent.id);
  await sql`UPDATE ship_intents SET tracking_comment_marker = ${canonicalMarker}, updated_at = now() WHERE id = ${intent.id}`;

  // T059 checkpoint: between intent creation and the first user-visible
  // mutation. If the maintainer issued bot:abort/stop in the milliseconds
  // since createIntent landed, bail before posting the tracking comment.
  if (await checkpointCancelled(intent.id)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intent.id, where: "post_create_intent" },
      "ship session cancelled at post-create checkpoint",
    );
    return;
  }

  // Create the tracking comment with the real intent id in the marker
  // so post-restart marker scans can re-discover it.
  const initialBody = renderTrackingComment({
    intent_id: intent.id,
    trigger_login: command.principal_login,
    deadline_at: deadlineAt,
    phase: "probing",
    last_action: `Probed merge-readiness — verdict: ${verdictLabel(probe.verdict)}`,
    iteration_n: 0,
    spent_usd: 0,
  });
  const trackingCommentId = await createTrackingComment({
    octokit,
    owner: command.pr.owner,
    repo: command.pr.repo,
    issue_number: command.pr.number,
    body: initialBody,
  });
  await persistTrackingCommentId(intent.id, trackingCommentId, sql);

  // T059 checkpoint: before any GraphQL mutation (markPullRequestReadyForReview).
  if (await checkpointCancelled(intent.id)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intent.id, where: "pre_terminal" },
      "ship session cancelled at pre-terminal checkpoint",
    );
    return;
  }

  // (e) Terminal shortcut — verdict is `ready`.
  if (probe.verdict.ready) {
    await terminalReady({
      octokit,
      command,
      intentId: intent.id,
      trackingCommentId,
      deadlineAt,
      isDraft: pr.isDraft,
      pullRequestNodeId: await getPullRequestNodeId(
        octokit,
        command.pr.owner,
        command.pr.repo,
        command.pr.number,
      ),
      log,
    });
    return;
  }

  // Non-ready verdict: US2 (T032+) implements the fix iteration loop.
  // For now: leave the intent active with the probing tracking-comment
  // body. The webhook reactor (T023-T027) will early-wake on PR/check
  // events and the cron tickle will re-enter — both no-ops until US2
  // wires the iteration. Soak-safe under the SHIP_USE_TRIGGER_SURFACES_V2
  // flag default-off.
  log.info(
    { event: "ship.session_started", intent_id: intent.id, verdict: verdictLabel(probe.verdict) },
    "ship session created — iteration loop pending US2",
  );
}

function verdictLabel(
  v: { readonly ready: true } | { readonly ready: false; readonly reason: string },
): string {
  return v.ready ? "ready" : v.reason;
}

function clampDeadline(requested: number | undefined): number {
  const max = config.maxWallClockPerShipRun;
  if (requested === undefined) return max;
  if (!Number.isFinite(requested) || requested <= 0) return max;
  return Math.min(requested, max);
}

async function postRefusal(
  octokit: Octokit,
  command: CanonicalCommand,
  reason: string,
  log: Logger,
): Promise<void> {
  const body = `\`bot:ship\` declined — ${reason}`;
  try {
    await octokit.rest.issues.createComment({
      owner: command.pr.owner,
      repo: command.pr.repo,
      issue_number: command.pr.number,
      body,
    });
  } catch (err) {
    log.warn({ err }, "ship refusal reply failed (best-effort)");
  }
}

async function postReply(
  octokit: Octokit,
  command: CanonicalCommand,
  body: string,
  log: Logger,
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner: command.pr.owner,
      repo: command.pr.repo,
      issue_number: command.pr.number,
      body,
    });
  } catch (err) {
    log.warn({ err }, "ship reply failed (best-effort)");
  }
}

async function getPullRequestNodeId(
  octokit: Pick<Octokit, "graphql">,
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  try {
    const data = await octokit.graphql<{
      repository: { pullRequest: { id: string } | null } | null;
    }>(
      `query GetPrId($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { id }
        }
      }`,
      { owner, repo, number },
    );
    return data.repository?.pullRequest?.id ?? null;
  } catch {
    return null;
  }
}

interface TerminalReadyInput {
  readonly octokit: Octokit;
  readonly command: CanonicalCommand;
  readonly intentId: string;
  readonly trackingCommentId: number;
  readonly deadlineAt: Date;
  readonly isDraft: boolean;
  readonly pullRequestNodeId: string | null;
  readonly log: Logger;
}

async function terminalReady(input: TerminalReadyInput): Promise<void> {
  const {
    octokit,
    command,
    intentId,
    trackingCommentId,
    deadlineAt,
    isDraft,
    pullRequestNodeId,
    log,
  } = input;

  // T059 checkpoint immediately before the GraphQL mutation.
  if (await checkpointCancelled(intentId)) {
    log.info(
      { event: "ship.checkpoint.cancelled", intent_id: intentId, where: "pre_mark_ready" },
      "terminalReady cancelled before markPullRequestReadyForReview",
    );
    return;
  }

  // (e)(1) markPullRequestReadyForReview — gated on isDraft. Failure
  // MUST NOT block (2)/(3) but MUST be surfaced.
  let markReadyError: string | null = null;
  if (isDraft && pullRequestNodeId !== null) {
    try {
      await octokit.graphql<MarkReadyResponse>(MARK_READY_FOR_REVIEW_MUTATION, {
        pullRequestId: pullRequestNodeId,
      });
      log.info(
        { event: "ship.ready_for_review", intent_id: intentId },
        "PR transitioned to ready-for-review",
      );
    } catch (err) {
      markReadyError = err instanceof Error ? err.message : String(err);
      log.error(
        { err, event: "ship.ready_for_review_failed", intent_id: intentId },
        "markPullRequestReadyForReview failed — proceeding with terminal transition",
      );
    }
  } else if (isDraft && pullRequestNodeId === null) {
    markReadyError = "could not resolve pull request node id";
    log.warn(
      { event: "ship.ready_for_review_skipped", intent_id: intentId },
      "skipped markPullRequestReadyForReview — node id unavailable",
    );
  }

  // (e)(2) update tracking comment to terminal state.
  const terminalBody = renderTrackingComment({
    intent_id: intentId,
    trigger_login: command.principal_login,
    deadline_at: deadlineAt,
    phase: "terminal",
    last_action:
      markReadyError === null
        ? "PR is merge-ready — handed back for human merge"
        : `PR is merge-ready — handed back for human merge (markReadyForReview failed: ${markReadyError})`,
    iteration_n: 0,
    spent_usd: 0,
    terminal_state: "ready_awaiting_human_merge",
  });
  try {
    await updateTrackingComment({
      octokit,
      owner: command.pr.owner,
      repo: command.pr.repo,
      comment_id: trackingCommentId,
      body: terminalBody,
    });
  } catch (err) {
    log.warn({ err }, "terminal tracking-comment update failed (best-effort)");
  }

  // (e)(3) transition to terminal state.
  await transitionToTerminal(intentId, "ready_awaiting_human_merge", null);
}
