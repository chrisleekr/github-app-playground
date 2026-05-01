import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-docs-citations.ts");

interface Layout {
  src?: Record<string, string>;
  docs?: Record<string, string>;
}

function makeFixture(layout: Layout): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-citations-"));
  mkdirSync(join(root, "src"));
  for (const [rel, body] of Object.entries(layout.src ?? {})) {
    const abs = join(root, "src", rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
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

describe("scripts/check-docs-citations.ts", () => {
  it("exits 0 when every src/<path>:<line> citation is in range", () => {
    const root = makeFixture({
      src: { "app.ts": "line1\nline2\nline3\nline4\nline5\n" },
      docs: { "page.md": "See `src/app.ts:3` for context.\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every src/<path>:<line> citation");
  });

  it("flags an out-of-range start line", () => {
    const root = makeFixture({
      src: { "app.ts": "line1\nline2\n" },
      docs: { "page.md": "See `src/app.ts:99`.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docs/page.md:1");
    expect(stderr).toContain("start line 99 out of range");
  });

  it("flags a citation pointing at a non-existent file", () => {
    const root = makeFixture({
      docs: { "page.md": "See `src/missing.ts:1`.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("file does not exist");
  });

  it("rejects `..` segments in the path component (regression: PR #88 thread 2)", () => {
    const root = makeFixture({
      src: { "app.ts": "real\n" },
      docs: { "page.md": "Bad: `src/sub/../app.ts:1`.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("path contains a `..` segment");
  });

  it("ignores bare `src/<path>` references without a line suffix", () => {
    const root = makeFixture({
      src: {},
      docs: { "page.md": "See `src/some/file.ts` for the gist.\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every src/<path>:<line> citation");
  });

  it("flags an end-line that exceeds the file length in a range citation", () => {
    const root = makeFixture({
      src: { "app.ts": "a\nb\nc\n" },
      docs: { "page.md": "See `src/app.ts:1-99`.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("end line 99 out of range");
  });
});
