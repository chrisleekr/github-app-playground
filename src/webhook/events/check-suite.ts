import type { CheckSuiteEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { fireReactor } from "../../workflows/ship/reactor-bridge";

/**
 * Handler for `check_suite.completed` events (T027). Fires the ship
 * reactor for every PR the suite is associated with so any active intent
 * on those PRs wakes early to inspect the new check state.
 */
export function handleCheckSuite(
  _octokit: Octokit,
  payload: CheckSuiteEvent,
  _deliveryId: string,
): void {
  if (payload.action !== "completed") return;
  if (payload.installation === undefined) return;

  const prNumbers = payload.check_suite.pull_requests.map((pr) => pr.number);
  if (prNumbers.length === 0) return;

  fireReactor({
    type: "check_suite.completed",
    installation_id: payload.installation.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pr_numbers: prNumbers,
  });
}
