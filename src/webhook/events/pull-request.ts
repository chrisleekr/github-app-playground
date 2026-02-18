import type { PullRequestEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";

/**
 * Handler for pull_request.opened events.
 * Registered in src/app.ts via app.webhooks.on("pull_request.opened", ...).
 *
 * Placeholder — no processing implemented yet.
 * Add trigger detection + processRequest() here when ready.
 */
export function handlePullRequest(
  _octokit: Octokit,
  payload: PullRequestEvent,
  deliveryId: string,
): void {
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
