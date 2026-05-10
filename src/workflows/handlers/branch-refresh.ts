import type { Octokit } from "octokit";

/**
 * Branch-staleness diagnostics for the `review` and `resolve` handlers.
 *
 * Both workflows operate on an open PR. If the head branch is behind base,
 * the agent's read of the code is stale; a senior engineer's first move
 * is to rebase onto current base and push. This module computes the
 * staleness signal and emits a prompt fragment that tells the agent
 * exactly what to do: including the no-op case (already up-to-date) so
 * the agent doesn't waste turns probing.
 *
 * Auto-rebase scope (per project direction 2026-04-25):
 *   - Behind base by ≥1 commit AND head is on the same repo as base
 *     (not a fork) → rebase, resolve conflicts, force-push.
 *   - Up-to-date → skip.
 *   - Fork PR → skip (no write access to fork) and tell the agent to
 *     comment on the PR instead, so the contributor knows.
 */

export interface BranchStaleness {
  /** Commits the head branch is behind the base branch (`base...head` ahead-of-base for context). */
  readonly commitsBehindBase: number;
  /** Commits the head branch is ahead of the base branch (PR's own work). */
  readonly commitsAheadOfBase: number;
  /**
   * `true` when the head ref lives on a different repo than base (fork PR).
   * The bot's installation token can't push to a fork's branch, so
   * auto-rebase is impossible: the agent must defer to the contributor.
   */
  readonly isFork: boolean;
  readonly headRef: string;
  readonly baseRef: string;
}

export async function getBranchStaleness(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<BranchStaleness> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number });

  const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name;

  const { data: cmp } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${pr.base.ref}...${pr.head.label}`,
  });

  // GitHub's compare API:
  //   - `behind_by` = commits the head ref lacks from base
  //   - `ahead_by`  = commits the head ref has that base lacks (PR's own work)
  return {
    commitsBehindBase: cmp.behind_by,
    commitsAheadOfBase: cmp.ahead_by,
    isFork,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
  };
}

export function formatRefreshDirective(s: BranchStaleness): string {
  if (s.commitsBehindBase === 0) {
    return [
      `## Branch state`,
      `\`${s.headRef}\` is up-to-date with \`${s.baseRef}\` (0 commits behind, ${String(s.commitsAheadOfBase)} ahead). No rebase required.`,
    ].join("\n");
  }

  if (s.isFork) {
    return [
      `## Branch state`,
      `\`${s.headRef}\` is **${String(s.commitsBehindBase)} commits behind** \`${s.baseRef}\`, but the head branch lives on a fork: the bot's installation token cannot push to it.`,
      ``,
      `Do NOT attempt to rebase. Instead, post a top-level PR comment via \`gh pr comment\` asking the contributor to rebase their branch onto \`${s.baseRef}\` and force-push, then proceed with the rest of your task against the current (stale) head. Note in your final report that the review/resolve was performed against a stale branch and call out which findings might be invalidated by the rebase.`,
    ].join("\n");
  }

  return [
    `## Branch state`,
    `\`${s.headRef}\` is **${String(s.commitsBehindBase)} commits behind** \`${s.baseRef}\` (${String(s.commitsAheadOfBase)} ahead). You MUST rebase before continuing: a stale branch means your work would be against outdated code.`,
    ``,
    `Steps:`,
    `1. \`git fetch origin\``,
    `2. \`git rebase origin/${s.baseRef}\``,
    `3. **If conflicts arise**, resolve them like a senior engineer: read the surrounding code, choose the correct merge, run \`bun run typecheck && bun test\` on the affected paths to confirm. Do NOT take "ours" or "theirs" blindly. \`git add\` the resolved files and \`git rebase --continue\`.`,
    `4. \`git push --force-with-lease origin ${s.headRef}\`, \`--force-with-lease\` (not \`--force\`) protects against overwriting concurrent pushes from a human contributor.`,
    `5. After push, the PR's head SHA changes, re-fetch any state you cached (failing checks, comments) before continuing your task.`,
    ``,
    `If the rebase is genuinely impossible (e.g., catastrophic conflicts you can't resolve safely), abort with \`git rebase --abort\`, then report the failure honestly in your final report and stop. Do NOT push a half-resolved rebase.`,
  ].join("\n");
}
