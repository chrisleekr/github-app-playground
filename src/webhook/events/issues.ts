import type { IssuesEvent } from "@octokit/webhooks-types";
import type { Octokit } from "octokit";

import { logger } from "../../logger";
import { dispatchByLabel } from "../../workflows/dispatcher";
import { dispatchCanonicalCommand } from "../../workflows/ship/command-dispatch";
import { routeTrigger } from "../../workflows/ship/trigger-router";
import { isOwnerAllowed } from "../authorize";

// Permits hyphenated verbs (e.g. `bot:open-pr`, `bot:fix-thread`); the verb
// must start with a letter and may contain `-`-separated lowercase segments.
const BOT_LABEL_PATTERN = /^bot:[a-z]+(?:-[a-z]+)*$/;

/**
 * Handler for `issues.labeled` and `issues.unlabeled`. Implements the label
 * dispatch protocol from `specs/20260421-181205-bot-workflows/contracts/
 * webhook-dispatch.md` §Label trigger:
 *
 *   1. label.name matches ^bot:[a-z]+$
 *   2. sender.login in ALLOWED_OWNERS
 *   → hand off to `dispatchByLabel` for the rest of the seven-step protocol.
 *
 * FR-015: events that fail precondition 2 produce no DB row, no queue job,
 * and no tracking comment — we log and return before touching the dispatcher.
 *
 * `unlabeled` is accepted so the webhook subscription stays symmetric with
 * `labeled`, but we deliberately do not run the dispatch protocol: label
 * removal is a reversal of a prior state, not a fresh trigger.
 */
export function handleIssues(octokit: Octokit, payload: IssuesEvent, deliveryId: string): void {
  if (payload.action === "unlabeled") {
    const removedLabel = payload.label?.name;
    if (removedLabel !== undefined && BOT_LABEL_PATTERN.test(removedLabel)) {
      logger.info(
        { deliveryId, removedLabel, owner: payload.repository.owner.login },
        "issues.unlabeled received for bot:* label — no-op (label removal is not a trigger)",
      );
    }
    return;
  }

  if (payload.action !== "labeled") return;

  const labelName = payload.label?.name;
  if (labelName === undefined || !BOT_LABEL_PATTERN.test(labelName)) return;

  const senderLogin = payload.sender.login;
  const log = logger.child({
    deliveryId,
    event: "issues.labeled",
    label: labelName,
    senderLogin,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issueNumber: payload.issue.number,
  });

  const auth = isOwnerAllowed(senderLogin, log);
  if (!auth.allowed) {
    log.info({ reason: auth.reason }, "issues.labeled: sender not in ALLOWED_OWNERS — dropped");
    return;
  }

  // Canonical routing wins; legacy `dispatchByLabel` runs only when
  // `routeTrigger` returns null. Without this precedence, an overlapping
  // label (e.g. `bot:triage`) fires both pipelines for one webhook.
  // FR-029..FR-035 eligibility — labels declared PR-only (e.g.
  // `bot:ship`) are rejected by the trigger-router and fall through to
  // the legacy path, which then ignores them.
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = payload.issue.number;
  const installationId = payload.installation?.id;

  void (async (): Promise<void> => {
    if (installationId !== undefined) {
      try {
        const command = await routeTrigger({
          surface: "label",
          payload: {
            label_name: labelName,
            principal_login: senderLogin,
            pr: { owner, repo, number: issueNumber, installation_id: installationId },
            event_surface: "issue-label",
          },
        });
        if (command !== null) {
          dispatchCanonicalCommand(command, { octokit, log });
          return;
        }
      } catch (err) {
        log.error({ err }, "trigger-router threw for issues.labeled");
      }
    }

    try {
      await dispatchByLabel({
        octokit,
        logger: log,
        label: labelName,
        target: { type: "issue", owner, repo, number: issueNumber },
        senderLogin,
        deliveryId,
      });
    } catch (err) {
      log.error({ err }, "dispatchByLabel threw for issues.labeled");
    }
  })();
}
