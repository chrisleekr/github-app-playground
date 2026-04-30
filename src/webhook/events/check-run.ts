import type { CheckRunEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { fireReactor } from "../../workflows/ship/reactor-bridge";

/**
 * Handler for `check_run.completed` events (T026). Fires the ship reactor
 * for every PR the check run is associated with so any active intent on
 * those PRs wakes early to inspect the new check state.
 *
 * `check_run.completed` is the only action we subscribe to — `created` and
 * `rerequested` are signal-only, and an active intent will pick up the
 * eventual `completed` from the same suite.
 */
export function handleCheckRun(
  _octokit: Octokit,
  payload: CheckRunEvent,
  _deliveryId: string,
): void {
  if (payload.action !== "completed") return;
  if (payload.installation === undefined) return;

  const prNumbers = payload.check_run.pull_requests.map((pr) => pr.number);
  if (prNumbers.length === 0) return;

  fireReactor({
    type: "check_run.completed",
    installation_id: payload.installation.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pr_numbers: prNumbers,
  });
}
