/**
 * Unit tests for src/core/checkout.ts.
 *
 * Drives `checkoutRepo` against a local fixture remote so the supplemental
 * base-branch fetch is exercised end-to-end. Uses git's `GIT_CONFIG_COUNT`
 * env-var family to redirect the hardcoded `https://github.com/...` URL to
 * a bare repo on disk — keeps the production path under test without
 * mocking the bun shell.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { config } from "../../src/config";
import { checkoutRepo } from "../../src/core/checkout";
import type { BotContext } from "../../src/types";
import { makeBotContext } from "../factories";

const FIXTURE_OWNER = "test-owner";
const FIXTURE_REPO = "test-repo";
const FIXTURE_URL = `https://github.com/${FIXTURE_OWNER}/${FIXTURE_REPO}.git`;

/** Roots created in beforeAll; cleaned up in afterAll. */
let fixturesRoot: string;
let bareRepoPath: string;
let cloneBaseDirOverride: string;
let originalCloneBaseDir: string;
let originalGitConfigEnv: Record<string, string | undefined>;

/**
 * Build a bare upstream with `main` + `feat/x` branches. Returns the
 * absolute filesystem path to the bare repo.
 */
async function buildBareFixture(): Promise<string> {
  const seedDir = await mkdtemp(join(fixturesRoot, "seed-"));
  const barePath = join(fixturesRoot, "upstream.git");

  // Seed working repo
  await $`git -C ${seedDir} init -b main -q`;
  await $`git -C ${seedDir} config user.email test@example.com`;
  await $`git -C ${seedDir} config user.name test`;
  await $`git -C ${seedDir} commit --allow-empty -m initial -q`;
  await $`git -C ${seedDir} checkout -q -b feat/x`;
  await $`git -C ${seedDir} commit --allow-empty -m head-only -q`;
  await $`git -C ${seedDir} checkout -q main`;
  await $`git -C ${seedDir} commit --allow-empty -m base-only -q`;

  // Bare clone — the "remote" the tests will pull from
  await $`git clone --bare -q ${seedDir} ${barePath}`;

  return barePath;
}

beforeAll(async () => {
  fixturesRoot = await mkdtemp(join(tmpdir(), "checkout-test-"));
  cloneBaseDirOverride = join(fixturesRoot, "clones");
  await mkdir(cloneBaseDirOverride, { recursive: true });
  bareRepoPath = await buildBareFixture();

  // Redirect the hardcoded GitHub URL inside checkoutRepo to the local
  // bare repo via git's GIT_CONFIG_COUNT/KEY/VALUE env vars.
  originalGitConfigEnv = {
    GIT_CONFIG_COUNT: process.env["GIT_CONFIG_COUNT"],
    GIT_CONFIG_KEY_0: process.env["GIT_CONFIG_KEY_0"],
    GIT_CONFIG_VALUE_0: process.env["GIT_CONFIG_VALUE_0"],
  };
  process.env["GIT_CONFIG_COUNT"] = "1";
  process.env["GIT_CONFIG_KEY_0"] = `url.${bareRepoPath}.insteadOf`;
  process.env["GIT_CONFIG_VALUE_0"] = FIXTURE_URL;

  originalCloneBaseDir = config.cloneBaseDir;
  // Mutate the config singleton — pattern matches other suites in the repo
  (config as { cloneBaseDir: string }).cloneBaseDir = cloneBaseDirOverride;
});

afterAll(async () => {
  (config as { cloneBaseDir: string }).cloneBaseDir = originalCloneBaseDir;

  for (const [key, val] of Object.entries(originalGitConfigEnv)) {
    if (val === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete, security/detect-object-injection
      delete process.env[key];
    } else {
      // eslint-disable-next-line security/detect-object-injection
      process.env[key] = val;
    }
  }

  await rm(fixturesRoot, { recursive: true, force: true });
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.shift();
    if (fn !== undefined) await fn();
  }
});

function makeCtx(overrides: Partial<BotContext>): BotContext {
  return makeBotContext({
    owner: FIXTURE_OWNER,
    repo: FIXTURE_REPO,
    deliveryId: `delivery-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    defaultBranch: "main",
    ...overrides,
  });
}

async function listRemoteRefs(workDir: string): Promise<string[]> {
  const out = await $`git -C ${workDir} branch -r`.text();
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes("->")); // drop "origin/HEAD -> origin/main" symbolic ref
}

describe("checkoutRepo supplemental base-branch fetch", () => {
  it("PR with head ≠ base — both refs resolvable after checkout", async () => {
    const ctx = makeCtx({ isPR: true, headBranch: "feat/x" });

    const { workDir, cleanup } = await checkoutRepo(ctx, "ignored-token", "main");
    cleanups.push(cleanup);

    const refs = await listRemoteRefs(workDir);
    expect(refs).toContain("origin/feat/x");
    expect(refs).toContain("origin/main");

    // Both refs must be resolvable for the agent's diff/rebase commands
    await $`git -C ${workDir} rev-parse origin/feat/x`.quiet();
    await $`git -C ${workDir} rev-parse origin/main`.quiet();
  });

  it("PR with head == base — no duplicate fetch attempted", async () => {
    const ctx = makeCtx({ isPR: true, headBranch: "main" });

    const { workDir, cleanup } = await checkoutRepo(ctx, "ignored-token", "main");
    cleanups.push(cleanup);

    const refs = await listRemoteRefs(workDir);
    // Only one remote-tracking branch — the supplemental fetch is skipped
    expect(refs).toEqual(["origin/main"]);
  });

  it("issue event (isPR=false) — no supplemental fetch even when baseBranch supplied", async () => {
    const ctx = makeCtx({ isPR: false });

    const { workDir, cleanup } = await checkoutRepo(ctx, "ignored-token", "feat/x");
    cleanups.push(cleanup);

    const refs = await listRemoteRefs(workDir);
    // Issue path clones the default branch only; supplemental fetch is gated on isPR
    expect(refs).toEqual(["origin/main"]);
  });

  it("PR with no baseBranch supplied — no supplemental fetch", async () => {
    const ctx = makeCtx({ isPR: true, headBranch: "feat/x" });

    const { workDir, cleanup } = await checkoutRepo(ctx, "ignored-token");
    cleanups.push(cleanup);

    const refs = await listRemoteRefs(workDir);
    expect(refs).toEqual(["origin/feat/x"]);
  });
});
