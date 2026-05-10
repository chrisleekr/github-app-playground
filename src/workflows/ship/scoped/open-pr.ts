/**
 * `bot:open-pr` scoped command (FR-035). For an actionable issue
 * (concrete bug or feature, per `meta-issue-classifier`), creates a
 * draft PR and back-links it to the source issue with a stable marker
 * `<!-- bot:open-pr:<pr_number> -->`. Re-trigger detection refuses
 * duplicate creation when the back-link marker is already present.
 *
 * Non-actionable issues receive a refusal reply citing the classifier's
 * verdict; no branch is created and no PR is opened.
 *
 * **The created draft PR does NOT auto-trigger `bot:ship`** (FR-018) —
 * the maintainer must invoke ship explicitly if they want shepherding
 * to start.
 *
 * Force-push and history-rewrite prohibitions (FR-009) apply to the
 * caller-supplied `createBranchAndPr` callback; this module performs
 * no git mutations directly.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { logger as rootLogger } from "../../../logger";
import { safePostToGitHub } from "../../../utils/github-output-guard";
import {
  classifyMetaIssue,
  type ClassifyMetaIssueInput,
  type MetaIssueVerdict,
} from "./meta-issue-classifier";

const SCOPED_MARKER_VERB = "open-pr";

function buildBackLinkMarker(pr_number: number): string {
  return `<!-- bot:${SCOPED_MARKER_VERB}:${pr_number} -->`;
}

/**
 * Match a marker WITHOUT a known PR number — used to detect any prior
 * back-link before creating a new PR. The verb prefix is stable; the
 * suffix is whatever PR number the bot last opened against the issue.
 */
const ANY_OPEN_PR_MARKER_PREFIX = `<!-- bot:${SCOPED_MARKER_VERB}:`;

export interface CreateBranchAndPrResult {
  readonly pr_number: number;
  readonly branch_name: string;
  readonly pr_url: string;
}

export interface RunOpenPrInput {
  readonly octokit: Pick<Octokit, "rest" | "paginate">;
  readonly owner: string;
  readonly repo: string;
  readonly issue_number: number;
  readonly callLlm: ClassifyMetaIssueInput["callLlm"];
  /**
   * Creates a draft branch and draft PR for the given issue. MUST NOT
   * force-push or rewrite history (FR-009). The PR MUST be created in
   * `draft` state and MUST NOT auto-trigger `bot:ship`.
   */
  readonly createBranchAndPr: (input: {
    issue_number: number;
    issue_title: string;
    verdict: MetaIssueVerdict;
  }) => Promise<CreateBranchAndPrResult>;
  readonly log?: Logger;
}

export type OpenPrOutcome =
  | {
      readonly kind: "non-actionable";
      readonly comment_id: number;
      readonly verdict: MetaIssueVerdict;
    }
  | {
      readonly kind: "duplicate";
      readonly comment_id: number;
      readonly existing_marker_comment_id: number;
    }
  | {
      readonly kind: "opened";
      readonly comment_id: number;
      readonly pr_number: number;
      readonly branch_name: string;
    }
  | {
      /**
       * Draft PR was created but the back-link marker comment failed to
       * post. The PR exists; future bot:open-pr triggers will create
       * duplicates because the marker is the dedup key. Operator must
       * manually post the marker on the source issue to reconcile.
       */
      readonly kind: "orphaned";
      readonly pr_number: number;
      readonly branch_name: string;
      readonly pr_url: string;
      readonly error_message: string;
    }
  | {
      readonly kind: "classifier-failed";
      readonly comment_id: number;
      readonly error_message: string;
    };

async function findExistingBackLink(input: {
  octokit: Pick<Octokit, "rest" | "paginate">;
  owner: string;
  repo: string;
  issue_number: number;
}): Promise<number | null> {
  const iter = input.octokit.paginate.iterator(input.octokit.rest.issues.listComments, {
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
    per_page: 100,
  });
  for await (const page of iter) {
    for (const comment of page.data) {
      // Spoofing guard: a human commenter can post a back-link marker
      // verbatim to permanently block `bot:open-pr` re-triggers. Only
      // markers authored by a Bot account count toward the dup check —
      // marker on a human comment is treated as conversation, not state.
      if (comment.user?.type !== "Bot") continue;
      const body = comment.body ?? "";
      if (body.includes(ANY_OPEN_PR_MARKER_PREFIX)) return comment.id;
    }
  }
  return null;
}

/**
 * Outcome of the policy-only phase (idempotency + classification +
 * non-actionable refusal). The caller decides what to do with an
 * `actionable` verdict — either create the PR inline (`runOpenPr`) or
 * enqueue an asynchronous daemon job (dispatch-scoped's `open-pr` path).
 *
 * Crucially, this phase NEVER posts the `<!-- bot:open-pr:N -->`
 * back-link marker. Posting the marker is the responsibility of whoever
 * actually creates the PR — posting it pre-emptively (e.g. with a
 * synthetic `pr_number: 0`) would permanently block re-triggers because
 * `findExistingBackLink` matches by the verb prefix alone.
 */
export type OpenPrPolicyOutcome =
  | {
      readonly kind: "non-actionable";
      readonly comment_id: number;
      readonly verdict: MetaIssueVerdict;
    }
  | {
      readonly kind: "duplicate";
      readonly comment_id: number;
      readonly existing_marker_comment_id: number;
    }
  | {
      readonly kind: "classifier-failed";
      readonly comment_id: number;
      readonly error_message: string;
    }
  | {
      readonly kind: "actionable";
      readonly verdict: MetaIssueVerdict;
      readonly issue_title: string;
    };

export async function runOpenPrPolicy(
  input: Omit<RunOpenPrInput, "createBranchAndPr">,
): Promise<OpenPrPolicyOutcome> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.open_pr",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });

  // Idempotency: existing back-link marker → refuse, link to existing PR.
  const existingMarkerId = await findExistingBackLink({
    octokit: input.octokit,
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });
  if (existingMarkerId !== null) {
    const guarded = await safePostToGitHub({
      body: `I already opened a PR for this issue — see comment #${existingMarkerId}. Re-trigger refused to avoid duplicates.`,
      source: "system",
      callsite: "ship.scoped.open-pr.duplicate",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.open-pr.duplicate: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info(
      { comment_id: guarded.result.data.id, existingMarkerId },
      "open_pr refused (duplicate)",
    );
    return {
      kind: "duplicate",
      comment_id: guarded.result.data.id,
      existing_marker_comment_id: existingMarkerId,
    };
  }

  const issue = await input.octokit.rest.issues.get({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });

  // Classify; on failure surface a maintainer-facing error per FR-017.
  let verdict: MetaIssueVerdict;
  try {
    verdict = await classifyMetaIssue({
      title: issue.data.title,
      body: issue.data.body ?? "",
      callLlm: input.callLlm,
    });
  } catch (err) {
    const error_message = err instanceof Error ? err.message : String(err);
    // Do NOT inline `error_message` in the public comment — LLM client
    // errors can carry the raw upstream response (request URLs with
    // bearer tokens, prompt fragments). The structured `error_message`
    // is still surfaced via the return value for operator dashboards
    // and the warn log line below carries the full `err`.
    const guarded = await safePostToGitHub({
      body: `I couldn't classify this issue. No PR opened — see server logs for details.`,
      source: "system",
      callsite: "ship.scoped.open-pr.classifier-failed",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.open-pr.classifier-failed: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
        { cause: err },
      );
    }
    log.warn({ err, comment_id: guarded.result.data.id }, "open_pr classifier failed");
    return { kind: "classifier-failed", comment_id: guarded.result.data.id, error_message };
  }

  if (!verdict.actionable) {
    // verdict.kind/verdict.reason are LLM-classifier output; route through
    // the agent-source path so the LLM scanner runs on the body.
    const guarded = await safePostToGitHub({
      body: `I'm not opening a PR for this — classifier kind is \`${verdict.kind}\`.\n\n> ${verdict.reason}`,
      source: "agent",
      callsite: "ship.scoped.open-pr.non-actionable",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.open-pr.non-actionable: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info({ comment_id: guarded.result.data.id, kind: verdict.kind }, "open_pr non-actionable");
    return { kind: "non-actionable", comment_id: guarded.result.data.id, verdict };
  }

  return { kind: "actionable", verdict, issue_title: issue.data.title };
}

export async function runOpenPr(input: RunOpenPrInput): Promise<OpenPrOutcome> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.open_pr",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
  });

  const policy = await runOpenPrPolicy({
    octokit: input.octokit,
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issue_number,
    callLlm: input.callLlm,
    ...(input.log ? { log: input.log } : {}),
  });
  if (policy.kind !== "actionable") return policy;
  const { verdict, issue_title } = policy;

  let created: CreateBranchAndPrResult;
  try {
    created = await input.createBranchAndPr({
      issue_number: input.issue_number,
      issue_title,
      verdict,
    });
  } catch (err) {
    // Without this guard, a thrown rejection from createBranchAndPr
    // exits runOpenPr with no maintainer-visible outcome — the issue
    // looks like the trigger was ignored. Surface the failure with the
    // same shape as the classifier-failed path so downstream handlers
    // (logs, dashboards) treat them uniformly.
    const error_message = err instanceof Error ? err.message : String(err);
    // Do NOT inline `error_message` in the public comment — octokit
    // error stacks include the request URL with the installation
    // token (`https://x-access-token:GHS_xxx@…`). The structured
    // `error_message` still flows out via the return value for operator
    // surfaces; the full `err` is logged below.
    const guarded = await safePostToGitHub({
      body: `I classified this issue as actionable but couldn't create the draft PR — see server logs for details.`,
      source: "system",
      callsite: "ship.scoped.open-pr.branch-failed",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.open-pr.branch-failed: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
        { cause: err },
      );
    }
    log.warn({ err, comment_id: guarded.result.data.id }, "open_pr branch/PR creation failed");
    return { kind: "classifier-failed", comment_id: guarded.result.data.id, error_message };
  }

  // Post the back-link comment with the marker so future re-triggers
  // detect this PR via the marker scan. If the comment write fails the
  // PR is orphaned (no marker → next trigger creates a duplicate); we
  // surface that distinct state so an operator can reconcile.
  const marker = buildBackLinkMarker(created.pr_number);
  let reply: { data: { id: number } };
  try {
    const guarded = await safePostToGitHub({
      body: `Opened draft PR #${created.pr_number} (\`${created.branch_name}\`): ${created.pr_url}\n\n${marker}`,
      source: "system",
      callsite: "ship.scoped.open-pr.back-link",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.open-pr.back-link: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    reply = guarded.result;
  } catch (err) {
    const error_message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        pr_number: created.pr_number,
        branch_name: created.branch_name,
        pr_url: created.pr_url,
      },
      "open_pr orphaned — draft PR opened but back-link comment failed",
    );
    return {
      kind: "orphaned",
      pr_number: created.pr_number,
      branch_name: created.branch_name,
      pr_url: created.pr_url,
      error_message,
    };
  }

  log.info(
    { comment_id: reply.data.id, pr_number: created.pr_number, branch_name: created.branch_name },
    "open_pr opened",
  );
  return {
    kind: "opened",
    comment_id: reply.data.id,
    pr_number: created.pr_number,
    branch_name: created.branch_name,
  };
}
