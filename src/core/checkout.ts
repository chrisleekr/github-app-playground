import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import { config } from "../config";
import type { BotContext, CheckoutResult } from "../types";
import { redactErrorMessage } from "../utils/log-redaction";
import { WORKSPACE_LOG_EVENTS } from "./workspace-events";

/**
 * Clone the repository to a unique temporary directory and configure git.
 *
 * Unlike claude-code-action (which runs inside a GitHub Actions runner with the
 * repo already checked out via actions/checkout), our GitHub App is a long-running
 * server with no local repo. Claude's file system tools (Read, Write, Edit, Glob,
 * Grep, LS) and git bash commands need a local filesystem to operate on.
 *
 * Auth pattern ported from claude-code-action's src/github/operations/git-config.ts:
 * uses x-access-token:<installation_token> for clone URL per
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
 */
export async function checkoutRepo(
  ctx: BotContext,
  installationToken: string,
  baseBranch?: string,
): Promise<CheckoutResult> {
  // Ensure base directory exists. Path is Zod-validated at startup (not user input).
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(config.cloneBaseDir, { recursive: true });

  // Unique temp dir per webhook delivery (concurrent isolation)
  const workDir = await mkdtemp(join(config.cloneBaseDir, `${ctx.deliveryId}-`));
  const log = ctx.log.child({ workDir });

  // Credential helper script path lives beside workDir (not inside) so it
  // is available before the clone creates the directory.
  const helperPath = `${workDir}.cred.sh`;

  try {
    // Shallow clone the specific branch for speed/disk savings
    // PRs: checkout PR head branch; Issues: checkout default branch
    const branch = ctx.isPR ? ctx.headBranch : ctx.defaultBranch;
    if (branch === undefined || branch === "") {
      throw new Error("No branch available for checkout");
    }

    // Write a credential helper script instead of passing the token as a git -c argument.
    // git -c http.extraHeader=... embeds the token in the process argument list, making it
    // readable via /proc/<PID>/cmdline by any process on the host.
    // A credential helper script (mode 0700) keeps the token off the process table.
    // See: https://git-scm.com/book/en/v2/Git-Tools-Credential-Storage
    const repoUrl = `https://github.com/${ctx.owner}/${ctx.repo}.git`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      helperPath,
      `#!/bin/sh\nprintf 'username=x-access-token\\npassword=${installationToken}\\n'\n`,
      { mode: 0o700 },
    );

    // Slug, not repoUrl: repoUrl embeds the install token via the credential helper path only,
    // but log the bare owner/repo slug so no auth material can ever land on a workspace event.
    const repoSlug = `${ctx.owner}/${ctx.repo}`;
    log.info(
      {
        event: WORKSPACE_LOG_EVENTS.cloneStarted,
        repo: repoSlug,
        branch,
        depth: config.cloneDepth,
      },
      "Cloning repository",
    );
    const cloneStartedAt = Date.now();
    await $`git clone --depth=${config.cloneDepth} --branch=${branch} --single-branch -c credential.helper=${helperPath} ${repoUrl} ${workDir}`;
    const cloneMs = Date.now() - cloneStartedAt;

    // Persist the credential helper for subsequent git operations (push, fetch)
    await $`git -C ${workDir} config credential.helper ${helperPath}`;

    // Configure git identity for commits (matches claude-code-action pattern)
    const botName = `chrisleekr-bot[bot]`;
    const botEmail = `${config.appId}+${botName}@users.noreply.github.com`;
    await $`git -C ${workDir} config user.name ${botName}`;
    await $`git -C ${workDir} config user.email ${botEmail}`;

    // PR events: --single-branch above narrowed remote.origin.fetch to the head ref
    // only, so origin/<baseBranch> is absent. The agent prompt and the auto-rebase
    // directive both reference it for diffs / rebases: a missing ref burns recovery
    // turns or silently falls back to `git diff HEAD`. Widen the refspec and pull
    // the base ref in. Best-effort: a missing base ref shouldn't break the request.
    if (ctx.isPR && baseBranch !== undefined && baseBranch !== "" && baseBranch !== branch) {
      try {
        await $`git -C ${workDir} remote set-branches --add origin ${baseBranch}`;
        // Both sides of the diff are bounded by CLONE_DEPTH. If head/base diverge by
        // more than that on long-lived branches, the merge base may not be reachable
        // locally and `git diff origin/<base>...HEAD` silently widens to the closest
        // shallow-boundary commit, bump CLONE_DEPTH or `git fetch --unshallow` if
        // an agent reports a noisy diff for a long-history base.
        await $`git -C ${workDir} fetch --depth=${config.cloneDepth} origin ${baseBranch}`;
        log.info(
          {
            event: WORKSPACE_LOG_EVENTS.baseBranchFetched,
            baseBranch,
            headBranch: branch,
          },
          "Fetched PR base branch",
        );
      } catch (err) {
        log.warn(
          {
            event: WORKSPACE_LOG_EVENTS.baseBranchFetchFailed,
            baseBranch,
            headBranch: branch,
            err: redactErrorMessage(err),
          },
          "Failed to fetch PR base branch, agent diff/rebase commands may fail",
        );
      }
    }

    log.info(
      { event: WORKSPACE_LOG_EVENTS.cloneCompleted, repo: repoSlug, branch, clone_ms: cloneMs },
      "Repository checked out and git configured",
    );

    return {
      workDir,
      cleanup: async (): Promise<void> => {
        log.info("Cleaning up workspace");
        await Promise.all([
          rm(workDir, { recursive: true, force: true }),
          rm(helperPath, { force: true }),
        ]);
      },
    };
  } catch (error) {
    // branch is scoped to the try; recompute from ctx (always defined) for the event.
    const failedBranch = ctx.isPR ? ctx.headBranch : ctx.defaultBranch;
    log.warn(
      {
        event: WORKSPACE_LOG_EVENTS.cloneFailed,
        repo: `${ctx.owner}/${ctx.repo}`,
        branch: failedBranch !== undefined && failedBranch !== "" ? failedBranch : "unknown",
        err: redactErrorMessage(error),
      },
      "Clone failed, removing partial workspace",
    );
    // Cleanup on clone failure (best-effort: swallow cleanup errors)
    await Promise.all([
      rm(workDir, { recursive: true, force: true }).catch(() => undefined),
      rm(helperPath, { force: true }).catch(() => undefined),
    ]);
    throw error;
  }
}
