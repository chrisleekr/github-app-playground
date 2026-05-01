import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-docs-versions.ts");

const PACKAGE_JSON = JSON.stringify(
  {
    name: "fixture",
    engines: { bun: ">=1.3.13" },
    packageManager: "bun@1.3.13",
  },
  null,
  2,
);

const DOCKERFILE_OK = `# fixture\nFROM oven/bun:1.3.13 AS base\nRUN echo hello\n`;
// Stale `oven/bun:` mention inside a comment — caught by the new line-scan.
const DOCKERFILE_STALE_COMMENT = `FROM oven/bun:1.3.13 AS base\n# /root is mode 700 in oven/bun:1.3.8\n`;

interface Layout {
  toolVersion: string;
  packageJson?: string;
  dockerfileOrch?: string;
  dockerfileDaemon?: string;
  docs?: Record<string, string>;
}

function makeFixture(layout: Layout): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-versions-"));
  writeFileSync(join(root, ".tool-versions"), `bun ${layout.toolVersion}\n`);
  writeFileSync(join(root, "package.json"), layout.packageJson ?? PACKAGE_JSON);
  writeFileSync(join(root, "Dockerfile.orchestrator"), layout.dockerfileOrch ?? DOCKERFILE_OK);
  writeFileSync(join(root, "Dockerfile.daemon"), layout.dockerfileDaemon ?? DOCKERFILE_OK);
  mkdirSync(join(root, "docs"));
  for (const [rel, body] of Object.entries(layout.docs ?? {})) {
    const abs = join(root, "docs", rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function runScript(repoRoot: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, DOCS_CHECK_REPO_ROOT: repoRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const fixtures: string[] = [];
afterEach(() => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) rmSync(f, { recursive: true, force: true });
  }
});

describe("scripts/check-docs-versions.ts", () => {
  it("exits 0 when every Bun reference matches the canonical pin", () => {
    const root = makeFixture({
      toolVersion: "1.3.13",
      docs: { "ops.md": "Bun **1.3.13** is required.\nUse `oven/bun:1.3.13`.\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every Bun version reference matches");
  });

  it("flags a Dockerfile comment whose `oven/bun:<ver>` has rotted (regression: PR #88 thread 1)", () => {
    const root = makeFixture({
      toolVersion: "1.3.13",
      dockerfileDaemon: DOCKERFILE_STALE_COMMENT,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Dockerfile.daemon:2");
    expect(stderr).toContain("oven/bun:1.3.8");
  });

  it("flags a doc mentioning a stale Bun semver in a Bun-context line", () => {
    const root = makeFixture({
      toolVersion: "1.3.13",
      docs: { "ops.md": "Bun 1.3.8 was the previous pin.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docs/ops.md:1");
    expect(stderr).toContain("found `1.3.8`");
  });

  it("ignores non-Bun semvers (Node, openssl) on lines that don't mention bun", () => {
    const root = makeFixture({
      toolVersion: "1.3.13",
      docs: { "ops.md": "Runtime requires Node 20.18.0 and openssl 3.0.14.\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every Bun version reference matches");
  });

  it("flags package.json `engines.bun` disagreement with the canonical pin", () => {
    const root = makeFixture({
      toolVersion: "1.3.13",
      packageJson: JSON.stringify({
        name: "fixture",
        engines: { bun: ">=1.3.8" },
        packageManager: "bun@1.3.13",
      }),
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("package.json");
    expect(stderr).toContain("engines.bun");
  });
});
