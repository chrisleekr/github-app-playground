import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";
import { dispatchByLabel } from "../../workflows/dispatcher";
import { isOwnerAllowed } from "../authorize";

const BOT_LABEL_PATTERN = /^bot:[a-z]+$/;

/**
 * Handler for `pull_request.*` events. Currently covers two actions:
 *
 *   - `opened` — placeholder (trigger detection lands when ready)
 *   - `labeled` — workflow dispatch (same seven-step protocol as issues)
 *
 * Registered in `src/app.ts`. Action dispatch happens inside this handler so
 * a single `app.webhooks.on("pull_request", ...)` registration covers both.
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
}
