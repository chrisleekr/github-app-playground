import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-action-pins.ts");

// A representative 40-char commit SHA (actions/checkout v6.0.2).
const SHA = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";

function makeFixture(workflows: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-action-pins-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(dir, name), body);
  }
  return root;
}

function runScript(repoRoot: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, ACTION_PINS_REPO_ROOT: repoRoot },
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

describe("scripts/check-action-pins.ts", () => {
  it("exits 0 when every uses: is SHA-pinned and ignores local workflow calls", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v6.0.2\n`,
      "release.yml": `jobs:\n  call:\n    uses: ./.github/workflows/ci.yml\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every third-party");
  });

  it("exits 1 when a uses: is pinned to a mutable tag", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6\n`,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ci.yml:4");
    expect(stderr).toContain("actions/checkout@v6");
  });

  it("ignores commented-out uses: lines", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    steps:\n      # - uses: anchore/sbom-action@v0\n      - uses: actions/checkout@${SHA} # v6.0.2\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every third-party");
  });

  it("accepts a quoted SHA-pinned ref without flagging the quote characters", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    steps:\n      - uses: "actions/checkout@${SHA}" # v6.0.2\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every third-party");
  });

  it("reports every unpinned reference across multiple workflow files", () => {
    const root = makeFixture({
      "a.yml": `jobs:\n  j:\n    steps:\n      - uses: docker/login-action@v4\n`,
      "b.yml": `jobs:\n  j:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n`,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("2 GitHub Action reference(s) not SHA-pinned");
  });
});
