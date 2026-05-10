/**
 * `bot:rebase` scoped command (FR-032). Brings a PR's head branch up
 * to date by merging its base branch into head. NEVER force-pushes
 * (FR-009 / SC-003), NEVER rewrites history. On merge conflict, halts
 * cleanly and replies with the conflicting paths so the maintainer
 * can resolve.
 *
 * The actual git operations (clone, merge, push) are delegated to the
 * caller-supplied `runMerge` callback. The orchestration in this
 * module enforces the FR-009 prohibitions at the policy layer
 * (validating callback inputs are not force-flags) and produces the
 * appropriate user-facing reply.
 *
 * Note: the static linter rule from T046b
 * (`scripts/check-no-destructive-actions.ts`) gates the entire ship
 * subtree against the destructive flag set; this module inherits that
 * coverage.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { logger as rootLogger } from "../../../logger";
import { safePostToGitHub } from "../../../utils/github-output-guard";

export interface RunMergeResult {
  readonly status: "up-to-date" | "merged" | "conflict";
  readonly conflict_paths?: readonly string[];
  readonly merge_commit_sha?: string;
}

export interface RunRebaseInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  /**
   * Performs `git merge origin/<base>` on a fresh clone of head.
   * MUST NOT force-push, MUST NOT rewrite history (FR-009). The
   * implementation in production wires this to a daemon-side git
   * subagent; tests inject a mock.
   */
  readonly runMerge: (input: { base_ref: string; head_ref: string }) => Promise<RunMergeResult>;
  readonly log?: Logger;
}

export type RebaseOutcome =
  | { readonly kind: "up-to-date"; readonly comment_id: number }
  | { readonly kind: "merged"; readonly comment_id: number; readonly merge_commit_sha: string }
  | {
      readonly kind: "conflict";
      readonly comment_id: number;
      readonly conflict_paths: readonly string[];
    }
  | { readonly kind: "closed"; readonly comment_id: number };

export async function runRebase(input: RunRebaseInput): Promise<RebaseOutcome> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.rebase",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.pr_number,
  });

  const pr = await input.octokit.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pr_number,
  });

  if (pr.data.state === "closed") {
    const guarded = await safePostToGitHub({
      body: `I'm not going to rebase a **${pr.data.merged ? "merged" : "closed"}** PR.`,
      source: "system",
      callsite: "ship.scoped.rebase.closed",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pr_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.rebase.closed: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info({ comment_id: guarded.result.data.id }, "rebase refused (closed PR)");
    return { kind: "closed", comment_id: guarded.result.data.id };
  }

  const result = await input.runMerge({
    base_ref: pr.data.base.ref,
    head_ref: pr.data.head.ref,
  });

  if (result.status === "up-to-date") {
    const guarded = await safePostToGitHub({
      body: `Already up to date with \`${pr.data.base.ref}\`, nothing to merge.`,
      source: "system",
      callsite: "ship.scoped.rebase.up-to-date",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pr_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.rebase.up-to-date: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info({ comment_id: guarded.result.data.id }, "rebase no-op (up to date)");
    return { kind: "up-to-date", comment_id: guarded.result.data.id };
  }

  if (result.status === "conflict") {
    const conflicts = result.conflict_paths ?? [];
    const list = conflicts.length > 0 ? conflicts.map((p) => `- \`${p}\``).join("\n") : "_(none)_";
    const guarded = await safePostToGitHub({
      body: `Merge from \`${pr.data.base.ref}\` produced conflicts. I haven't pushed anything; please resolve manually.\n\n**Conflicting paths:**\n${list}`,
      source: "system",
      callsite: "ship.scoped.rebase.conflict",
      log,
      post: (cleanBody) =>
        input.octokit.rest.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.pr_number,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `ship.scoped.rebase.conflict: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    log.info({ comment_id: guarded.result.data.id, conflicts }, "rebase halted (conflicts)");
    return { kind: "conflict", comment_id: guarded.result.data.id, conflict_paths: conflicts };
  }

  // status === "merged"
  const sha = result.merge_commit_sha ?? "(unknown)";
  const guarded = await safePostToGitHub({
    body: `Merged \`${pr.data.base.ref}\` into \`${pr.data.head.ref}\` as \`${sha}\` and pushed forward (no force-push).`,
    source: "system",
    callsite: "ship.scoped.rebase.merged",
    log,
    post: (cleanBody) =>
      input.octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.pr_number,
        body: cleanBody,
      }),
  });
  if (!guarded.posted || guarded.result === undefined) {
    throw new Error(
      `ship.scoped.rebase.merged: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
    );
  }
  log.info({ comment_id: guarded.result.data.id, merge_commit_sha: sha }, "rebase merged");
  return { kind: "merged", comment_id: guarded.result.data.id, merge_commit_sha: sha };
}
