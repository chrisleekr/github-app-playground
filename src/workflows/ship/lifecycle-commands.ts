/**
 * Stop / resume / abort lifecycle command handlers (T058, T058b, US4).
 * Consumes a `CanonicalCommand` (intent ∈ {stop, resume, abort}) and
 * applies the documented state transitions per
 * `contracts/bot-commands.md`.
 *
 * Authorisation (FR-028) is uniform across surfaces — the canonical
 * command's `principal_login` is checked against `ALLOWED_OWNERS` here,
 * after the trigger router has normalised the input.
 *
 * Cooperative-then-forced cancellation (R11):
 *   stop  → set Valkey cancel flag, wait ≤2s for cooperative checkpoint,
 *           else force-pause via guarded UPDATE
 *   abort → set Valkey cancel flag, wait ≤2s, else `forceAbortIntent`
 *   resume → verify no foreign push since pause; clear cancel flag;
 *            transition paused→active; re-enqueue continuation
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { config } from "../../config";
import { requireDb } from "../../db";
import { getValkeyClient } from "../../orchestrator/valkey";
import type { CanonicalCommand } from "../../shared/ship-types";
import { clearAbort, requestAbort } from "./abort";
import {
  forceAbortIntent,
  getActiveIntent,
  pauseIntent,
  resumeIntent,
  transitionToTerminal,
} from "./intent";
import { TICKLE_KEY } from "./webhook-reactor";

/**
 * After setting the cancel flag, give in-flight workers up to this much
 * wall-clock to reach a safe checkpoint and bail. We don't need a
 * positive ack — `pauseIntent`/`forceAbortIntent` use guarded UPDATEs
 * (`WHERE status IN ('active', 'paused')`), so even racing the worker is
 * safe; the wait just makes the user-visible state quieter.
 */
const POST_FLAG_WAIT_MS = 2000;
const BOT_APP_LOGIN = "chrisleekr-bot[bot]";

export interface RunLifecycleInput {
  readonly command: CanonicalCommand;
  readonly octokit: Octokit;
  readonly log: Logger;
}

function isAuthorised(login: string): boolean {
  const allowed = config.allowedOwners;
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.some((o) => o.toLowerCase() === login.toLowerCase());
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
    log.warn({ err }, "lifecycle reply failed (best-effort)");
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runLifecycleCommand(input: RunLifecycleInput): Promise<void> {
  const { command, octokit, log } = input;

  if (!isAuthorised(command.principal_login)) {
    log.info(
      { event: "ship.lifecycle.unauthorised", surface: command.surface },
      "lifecycle command rejected — principal not in ALLOWED_OWNERS",
    );
    await postReply(
      octokit,
      command,
      `\`bot:${command.intent}\` declined — \`@${command.principal_login}\` is not in ALLOWED_OWNERS.`,
      log,
    );
    return;
  }

  const sql = requireDb();
  const valkey = getValkeyClient();
  const intent = await getActiveIntent(command.pr.owner, command.pr.repo, command.pr.number, sql);
  if (intent === null) {
    log.info({ event: "ship.lifecycle.no_active_intent" }, "no active session for this PR");
    await postReply(
      octokit,
      command,
      `\`bot:${command.intent}\` is a no-op — no active \`bot:ship\` session for this PR.`,
      log,
    );
    return;
  }

  if (command.intent === "stop") {
    if (intent.status === "paused") {
      await postReply(
        octokit,
        command,
        `\`bot:stop\` is a no-op — session is already paused.`,
        log,
      );
      return;
    }
    if (valkey !== null) await requestAbort(intent.id, valkey);
    await sleep(POST_FLAG_WAIT_MS);
    const paused = await pauseIntent(intent.id, command.principal_login, sql);
    log.info(
      { event: "ship.lifecycle.stop", intent_id: intent.id, paused: paused !== null },
      "ship session paused",
    );
    await postReply(
      octokit,
      command,
      `\`bot:ship\` paused — comment \`bot:resume\` to continue.`,
      log,
    );
    return;
  }

  if (command.intent === "resume") {
    if (intent.status === "active") {
      await postReply(
        octokit,
        command,
        `\`bot:resume\` is a no-op — session is already active.`,
        log,
      );
      return;
    }
    // Foreign-push detection (FR-010): resume MUST NOT proceed if a
    // non-bot push happened while paused. This requires a probe — we
    // check `target_head_sha` recorded on the intent vs. current PR
    // head via REST.
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: command.pr.owner,
        repo: command.pr.repo,
        pull_number: command.pr.number,
      });
      if (pr.head.sha !== intent.target_head_sha) {
        const author = pr.head.user?.login ?? null;
        if (author !== BOT_APP_LOGIN) {
          await transitionToTerminal(intent.id, "human_took_over", "manual-push-detected", sql);
          log.info(
            { event: "ship.lifecycle.resume_aborted_foreign_push", intent_id: intent.id },
            "resume aborted — foreign push detected",
          );
          await postReply(
            octokit,
            command,
            `\`bot:resume\` aborted — a non-bot push (\`${pr.head.sha.slice(0, 7)}\`) ` +
              `arrived while paused. Session terminated as \`human_took_over\`.`,
            log,
          );
          return;
        }
      }
    } catch (err) {
      log.warn({ err }, "resume foreign-push check failed — proceeding cautiously");
    }
    if (valkey !== null) {
      await clearAbort(intent.id, valkey);
      await valkey.send("ZADD", [TICKLE_KEY, "0", intent.id]);
    }
    const resumed = await resumeIntent(intent.id, command.principal_login, sql);
    log.info(
      { event: "ship.lifecycle.resume", intent_id: intent.id, resumed: resumed !== null },
      "ship session resumed",
    );
    await postReply(octokit, command, `\`bot:ship\` resumed.`, log);
    return;
  }

  // abort — set flag, give workers a chance to bail at next checkpoint,
  // then force-transition. The guarded UPDATE inside `forceAbortIntent`
  // wins any race with a worker that didn't reach the checkpoint in
  // time; the worker will then see the cancel flag at its next poll
  // and bail before mutating.
  if (valkey !== null) await requestAbort(intent.id, valkey);
  await sleep(POST_FLAG_WAIT_MS);
  await forceAbortIntent(intent.id, command.principal_login, sql);
  log.info({ event: "ship.lifecycle.abort", intent_id: intent.id }, "ship session aborted");
  await postReply(octokit, command, `\`bot:ship\` aborted.`, log);
}
