/**
 * Daemon-side `scoped-rebase` executor (T029, US3). Deterministic git only —
 * no Agent SDK invocation. Implements `contracts/job-kinds.md#scoped-rebase`:
 *
 *   1. Fetch PR via Octokit; abort `closed` if PR is closed/merged.
 *   2. Clone head branch to a temp dir.
 *   3. `git fetch origin <base_ref>` + `git merge origin/<base_ref>` —
 *      explicitly NO `--ff-only`, NO `--rebase`, NO `--force`.
 *   4. Push the merge commit if produced; never `-f`/`--force`/`--force-with-lease`.
 *   5. On conflict: collect paths via `git diff --name-only --diff-filter=U`,
 *      abort the merge cleanly, return `conflict` with the path list.
 *   6. Always clean up the temp dir.
 *
 * Idempotency: callers (orchestrator-side) MUST check the existing
 * tracking-comment durable layer before dispatch (per
 * `contracts/job-kinds.md` Idempotency). The executor itself is a single
 * deterministic git operation; re-deliveries with the same `triggerCommentId`
 * MUST produce equivalent outcomes.
 *
 * Static guarantees (FR-009 / SC-003): this file ships in `src/daemon/` so
 * `scripts/check-no-destructive-actions.ts` covers it; any `--force` /
 * `--force-with-lease` literal would be caught at lint time.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import { Octokit } from "octokit";

import { logger } from "../logger";
import { type RebaseOutcome, runRebase } from "../workflows/ship/scoped/rebase";

export interface ScopedRebaseExecutorInput {
  readonly installationToken: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

/**
 * Run the scoped-rebase pipeline end-to-end. Returns the policy-layer
 * `RebaseOutcome` so the orchestrator-side completion handler can map it
 * onto the `scoped-job-completion` payload without re-deriving the result.
 *
 * @throws when the temp-dir cannot be created or the policy callback
 *         surfaces an unrecoverable git error other than a conflict.
 */
export async function executeScopedRebase(
  input: ScopedRebaseExecutorInput,
): Promise<RebaseOutcome> {
  const log = logger.child({
    component: "daemon.scoped-rebase",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.prNumber,
  });

  const octokit = new Octokit({ auth: input.installationToken });

  const baseDir = join(tmpdir(), "scoped-rebase");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(baseDir, { recursive: true });
  const workDir = await mkdtemp(join(baseDir, `${input.owner}-${input.repo}-`));
  const helperPath = `${workDir}.cred.sh`;

  try {
    return await runRebase({
      octokit,
      owner: input.owner,
      repo: input.repo,
      pr_number: input.prNumber,
      log,
      runMerge: async ({ base_ref, head_ref }) => {
        const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;
        // Credential helper avoids embedding the token in the argv table.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(
          helperPath,
          `#!/bin/sh\nprintf 'username=x-access-token\\npassword=${input.installationToken}\\n'\n`,
          { mode: 0o700 },
        );

        log.info({ workDir, head_ref, base_ref }, "Cloning head branch for scoped-rebase");
        await $`git clone --branch=${head_ref} --single-branch -c credential.helper=${helperPath} ${repoUrl} ${workDir}`;
        await $`git -C ${workDir} config credential.helper ${helperPath}`;
        await $`git -C ${workDir} config user.name ${"chrisleekr-bot[bot]"}`;
        await $`git -C ${workDir} config user.email ${"chrisleekr-bot[bot]@users.noreply.github.com"}`;

        // Bring base into the local clone, then merge it into head. Never
        // `--ff-only` (we want the merge commit), never `--rebase`, never
        // `--force`. The static linter rule guards against regressions.
        await $`git -C ${workDir} fetch origin ${base_ref}`;
        const mergeResult = await $`git -C ${workDir} merge origin/${base_ref} --no-edit`.nothrow();

        if (mergeResult.exitCode === 0) {
          const stdout = mergeResult.stdout.toString();
          if (stdout.includes("Already up to date")) {
            return { status: "up-to-date" };
          }
          // Capture the merge commit SHA before pushing so we can report it.
          const headSha = (await $`git -C ${workDir} rev-parse HEAD`.text()).trim();
          await $`git -C ${workDir} push origin HEAD:${head_ref}`;
          return { status: "merged", merge_commit_sha: headSha };
        }

        // Conflict path. Collect conflicting paths and abort cleanly.
        const conflictsRaw = await $`git -C ${workDir} diff --name-only --diff-filter=U`.text();
        const conflict_paths = conflictsRaw
          .split("\n")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        await $`git -C ${workDir} merge --abort`.nothrow();
        return { status: "conflict", conflict_paths };
      },
    });
  } finally {
    await Promise.all([
      rm(workDir, { recursive: true, force: true }),
      rm(helperPath, { force: true }),
    ]);
  }
}
