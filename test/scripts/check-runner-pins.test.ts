import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-runner-pins.ts");

function makeFixture(workflows: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-runner-pins-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(dir, name), body);
  }
  return root;
}

function runScript(repoRoot: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT], {
    env: { ...process.env, RUNNER_PINS_REPO_ROOT: repoRoot },
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

describe("scripts/check-runner-pins.ts", () => {
  it("exits 0 when every runs-on pins an explicit image", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    runs-on: ubuntu-24.04\n`,
      "docs.yml": `jobs:\n  b:\n    runs-on: ubuntu-24.04-arm\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `runs-on:`");
  });

  it("exits 1 when a runs-on uses ubuntu-latest", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    runs-on: ubuntu-latest\n`,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ci.yml:3");
    expect(stderr).toContain("ubuntu-latest");
  });

  it("flags windows-latest and macos-latest aliases too", () => {
    const root = makeFixture({
      "a.yml": `jobs:\n  j:\n    runs-on: windows-latest\n`,
      "b.yml": `jobs:\n  j:\n    runs-on: macos-latest\n`,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("2 runner(s) on a `*-latest` rolling alias");
  });

  it("skips a GitHub Actions matrix expression", () => {
    const root = makeFixture({
      "docker-build.yml": `jobs:\n  build:\n    runs-on: \${{ matrix.runner }}\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `runs-on:`");
  });

  it("accepts a quoted explicit runner without flagging the quotes", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    runs-on: "ubuntu-24.04"\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `runs-on:`");
  });

  it("excludes a trailing comment from the captured label", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n    runs-on: ubuntu-latest # pin me\n`,
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    // `\S+` capture stops at the space, so the label is `ubuntu-latest`, not
    // `ubuntu-latest # pin me`.
    expect(stderr).toContain("runs-on `ubuntu-latest`");
  });

  it("ignores commented-out runs-on lines", () => {
    const root = makeFixture({
      "ci.yml": `jobs:\n  a:\n      # runs-on: ubuntu-latest\n    runs-on: ubuntu-24.04\n`,
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every `runs-on:`");
  });
});
