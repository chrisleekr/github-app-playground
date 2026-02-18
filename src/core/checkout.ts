import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { $ } from "bun";

import { config } from "../config";
import type { BotContext, CheckoutResult } from "../types";

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

    log.info({ branch, depth: config.cloneDepth }, "Cloning repository");
    await $`git clone --depth=${config.cloneDepth} --branch=${branch} --single-branch -c credential.helper=${helperPath} ${repoUrl} ${workDir}`;

    // Persist the credential helper for subsequent git operations (push, fetch)
    await $`git -C ${workDir} config credential.helper ${helperPath}`;

    // Configure git identity for commits (matches claude-code-action pattern)
    const botName = `chrisleekr-bot[bot]`;
    const botEmail = `${config.appId}+${botName}@users.noreply.github.com`;
    await $`git -C ${workDir} config user.name ${botName}`;
    await $`git -C ${workDir} config user.email ${botEmail}`;

    log.info("Repository checked out and git configured");

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
    // Cleanup on clone failure (both workDir and the helper script)
    await Promise.all([
      rm(workDir, { recursive: true, force: true }).catch(() => {}),
      rm(helperPath, { force: true }).catch(() => {}),
    ]);
    throw error;
  }
}
