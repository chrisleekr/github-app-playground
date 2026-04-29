/**
 * Daemon-side `scoped-open-pr` executor (T032, US3). Per
 * `contracts/job-kinds.md#scoped-open-pr` the production executor clones
 * the default branch, scaffolds a feature branch via the Agent SDK,
 * pushes, and opens a PR linking the originating issue.
 *
 * **Scaffolding boundary**: this commit lands the Octokit issue-reply
 * path so the dispatch layer's `createBranchAndPr` callback no longer
 * throws the legacy maintainer-notice (FR-021). The clone + Agent SDK invocation +
 * `createPullRequest` call lands as a follow-up.
 *
 * Halt conditions per the contract:
 *   - Agent produces no diff → halt with `reason: "no scaffold produced"`;
 *     do NOT push an empty branch.
 *   - Default branch is unknown / not protected → halt and surface error.
 *
 * Both become real once the Agent SDK call is wired; the executor today
 * returns `halted` with a structured reason that the server-side
 * completion bridge formats as the user-facing reply.
 */

import { Octokit } from "octokit";

import { logger } from "../logger";

export interface ScopedOpenPrExecutorInput {
  readonly installationToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly triggerCommentId: number;
  readonly verdictSummary: string;
}

export interface ScopedOpenPrOutcome {
  readonly status: "succeeded" | "halted";
  readonly newPrNumber?: number;
  readonly pushedCommitSha?: string;
  readonly reason?: string;
}

/**
 * Post a maintainer-facing reply on the originating issue documenting
 * the scaffolding boundary, then return halted. The verdictSummary is
 * surfaced verbatim so the maintainer can see what the policy layer
 * deemed actionable.
 */
export async function executeScopedOpenPr(
  input: ScopedOpenPrExecutorInput,
): Promise<ScopedOpenPrOutcome> {
  const log = logger.child({
    component: "daemon.scoped-open-pr",
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
  });

  const octokit = new Octokit({ auth: input.installationToken });
  await octokit.rest.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.issueNumber,
    body:
      `\`bot:open-pr\` daemon-side executor is scaffolded — clone + branch + ` +
      `Agent SDK scaffolding + \`gh pr create\` invocation is the next follow-up. ` +
      `Policy verdict (verbatim):\n\n> ${input.verdictSummary.replaceAll("\n", "\n> ")}`,
  });

  log.info(
    { event: "ship.scoped.open_pr.daemon.completed" },
    "scoped-open-pr reply posted (scaffolding boundary)",
  );

  return {
    status: "halted",
    reason: "agent-sdk invocation + branch creation pending follow-up",
  };
}
