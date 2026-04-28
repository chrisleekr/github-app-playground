import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { config } from "../../config";
import { logger } from "../../logger";
import { dispatchByLabel } from "../../workflows/dispatcher";
import { dispatchCanonicalCommand } from "../../workflows/ship/command-dispatch";
import { fireReactor } from "../../workflows/ship/reactor-bridge";
import { routeTrigger } from "../../workflows/ship/trigger-router";
import { isOwnerAllowed } from "../authorize";

// Permits the documented label shapes:
//   bot:ship, bot:abort-ship, bot:fix-thread, bot:investigate, ...
//   bot:ship/deadline=2h (parameterised ship)
const BOT_LABEL_PATTERN = /^bot:[a-z][a-z-]*(?:\/deadline=\d+(?:\.\d+)?[hms])?$/;

/**
 * Handler for `pull_request.*` events. Currently covers four actions:
 *
 *   - `opened` — placeholder (trigger detection lands when ready)
 *   - `labeled` — legacy workflow dispatch + ship reactor label dispatch (T028d)
 *   - `synchronize` — ship reactor early-wake / foreign-push detection (T023)
 *   - `closed` — ship reactor terminal transition (merged_externally / pr_closed) (T023)
 *
 * Registered in `src/app.ts`. Action dispatch happens inside this handler so
 * a single `app.webhooks.on("pull_request", ...)` registration covers all.
 */
export function handlePullRequest(
  octokit: Octokit,
  payload: PullRequestEvent,
  deliveryId: string,
): void {
  if (payload.action === "labeled") {
    handlePullRequestLabeled(octokit, payload, deliveryId);
    return;
  }

  if (payload.action === "synchronize") {
    if (payload.installation === undefined) return;
    fireReactor({
      type: "pull_request.synchronize",
      installation_id: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pr_number: payload.pull_request.number,
      head_sha: payload.pull_request.head.sha,
      head_author_login: payload.sender.login,
    });
    return;
  }

  if (payload.action === "closed") {
    if (payload.installation === undefined) return;
    fireReactor({
      type: "pull_request.closed",
      installation_id: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pr_number: payload.pull_request.number,
      merged: payload.pull_request.merged,
    });
    return;
  }

  if (payload.action !== "opened") return;

  logger.info(
    {
      deliveryId,
      action: payload.action,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    },
    "pull_request.opened received (no action configured)",
  );
}

function handlePullRequestLabeled(
  octokit: Octokit,
  payload: PullRequestEvent & { action: "labeled" },
  deliveryId: string,
): void {
  const labelName = payload.label?.name;
  if (labelName === undefined || !BOT_LABEL_PATTERN.test(labelName)) return;

  const senderLogin = payload.sender.login;
  const log = logger.child({
    deliveryId,
    event: "pull_request.labeled",
    label: labelName,
    senderLogin,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.pull_request.number,
  });

  const auth = isOwnerAllowed(senderLogin, log);
  if (!auth.allowed) {
    log.info(
      { reason: auth.reason },
      "pull_request.labeled: sender not in ALLOWED_OWNERS — dropped",
    );
    return;
  }

  void dispatchByLabel({
    octokit,
    logger: log,
    label: labelName,
    target: {
      type: "pr",
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      number: payload.pull_request.number,
    },
    senderLogin,
    deliveryId,
  }).catch((err: unknown) => {
    log.error({ err }, "dispatchByLabel threw for pull_request.labeled");
  });

  // T028d: ship trigger-surface dispatch (flag-gated). The legacy
  // dispatchByLabel path above is preserved; this adds the new normalised
  // CanonicalCommand path for ship/stop/resume/abort labels.
  if (config.shipUseTriggerSurfacesV2 && payload.installation !== undefined) {
    const installationId = payload.installation.id;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = payload.pull_request.number;
    void (async (): Promise<void> => {
      try {
        const command = await routeTrigger({
          surface: "label",
          payload: {
            label_name: labelName,
            principal_login: senderLogin,
            pr: { owner, repo, number: prNumber, installation_id: installationId },
          },
        });
        if (command !== null) dispatchCanonicalCommand(command, { octokit, log });
      } catch (err) {
        log.error({ err }, "trigger-router threw for pull_request.labeled");
      }
    })();
  }
}
