import type { PullRequestReviewEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";

/**
 * Handler for pull_request_review.submitted events.
 * Registered in src/app.ts via app.webhooks.on("pull_request_review.submitted", ...).
 *
 * Placeholder — no processing implemented yet.
 * Add trigger detection + processRequest() here when ready.
 */
export function handleReview(
  _octokit: Octokit,
  payload: PullRequestReviewEvent,
  deliveryId: string,
): void {
  if (payload.action !== "submitted") return;

  logger.info(
    {
      deliveryId,
      action: payload.action,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    },
    "pull_request_review.submitted received (no action configured)",
  );
}
