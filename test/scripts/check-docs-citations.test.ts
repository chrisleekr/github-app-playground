import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

const SCRIPT = resolve(import.meta.dir, "..", "..", "scripts", "check-docs-citations.ts");

interface Layout {
  src?: Record<string, string>;
  docs?: Record<string, string>;
  // Root-level Markdown (README.md / CONTRIBUTING.md / CLAUDE.md), keyed by filename.
  rootDocs?: Record<string, string>;
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
  for (const [name, body] of Object.entries(layout.rootDocs ?? {})) {
    writeFileSync(join(root, name), body);
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

  it("passes a valid citation in a root-level doc (issue #136)", () => {
    const root = makeFixture({
      src: { "app.ts": "a\nb\nc\nd\n" },
      rootDocs: { "README.md": "See `src/app.ts:2` for the entrypoint.\n" },
    });
    fixtures.push(root);
    const { exitCode, stdout } = runScript(root);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK: every src/<path>:<line> citation");
  });

  it("scans root-level CONTRIBUTING.md and flags a broken citation there (issue #136)", () => {
    const root = makeFixture({
      rootDocs: { "CONTRIBUTING.md": "See `src/gone.ts:1` for details.\n" },
    });
    fixtures.push(root);
    const { exitCode, stderr } = runScript(root);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("CONTRIBUTING.md:1");
    expect(stderr).toContain("file does not exist");
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

  // Anchor-verification cases (issue #158): close the silent-rot gap the
  // bounds-only check misses when a refactor shifts a cited symbol but
  // leaves the new offset inside the file.
  describe("anchor verification (#symbol suffix)", () => {
    it("passes when the anchor token appears on the cited line", () => {
      const root = makeFixture({
        src: { "app.ts": "// line1\nexport function buildPrompt() {}\n// line3\n" },
        docs: { "page.md": "See `src/app.ts:2#buildPrompt` for the builder.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("flags an anchor that is in-bounds but on the wrong line (the silent-rot regression)", () => {
      // Mirrors the issue's live example: `buildPrompt` moved from line 2
      // down to line 4, but the doc still cites line 2. Bounds-only passes;
      // anchored check fails.
      const root = makeFixture({
        src: {
          "app.ts": "// preamble\n// preamble\n// preamble\nexport function buildPrompt() {}\n",
        },
        docs: { "page.md": "See `src/app.ts:2#buildPrompt` for the builder.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `buildPrompt` not found on cited line 2");
    });

    it("matches the anchor whole-word so `buildPrompt` doesn't match `buildPromptParts`", () => {
      const root = makeFixture({
        src: { "app.ts": "// line1\nexport function buildPromptParts() {}\n" },
        docs: { "page.md": "See `src/app.ts:2#buildPrompt`.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `buildPrompt` not found");
    });

    it("accepts a multi-line range when the anchor appears anywhere inside it", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\nexport function buildPrompt() {}\n// l5\n" },
        docs: { "page.md": "Block `src/app.ts:2-4#buildPrompt` covers the def.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("flags a multi-line range whose anchor falls outside the range", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\n// l4\nexport function buildPrompt() {}\n" },
        docs: { "page.md": "Bad: `src/app.ts:1-3#buildPrompt`.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `buildPrompt` not found on cited lines 1-3");
    });

    it("leaves anchorless citations on the bounds-only path (no flag day)", () => {
      // No anchor → today's behaviour. Line 2 is in bounds; content is
      // irrelevant. This is the backward-compat guarantee.
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2 unrelated content\n// l3\n" },
        docs: { "page.md": "See `src/app.ts:2` for context.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("accepts `$` and `_` in anchor tokens (JS-identifier shape)", () => {
      const root = makeFixture({
        src: { "app.ts": "const _$private_helper = 1;\n" },
        docs: { "page.md": "See `src/app.ts:1#_$private_helper`.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("treats malformed anchors (leading digit) as anchorless citations (matches `main`'s pre-anchor behaviour)", () => {
      // `42abc` can't bind to the anchor group (leading digit fails the
      // `[A-Za-z_$]` first-char requirement). The optional group does
      // not match, the citation falls through to its bounds-only form
      // `src/app.ts:1`, and the gate validates that. This is the same
      // behaviour `main` had before anchor support landed: malformed
      // anchor suffixes are not interpreted, and the rest of the
      // citation is still checked. Loudly rejecting malformed anchors
      // would require a broader negative lookahead that also breaks
      // citations followed by sentence-ending `.` (see trailing-period
      // tests below), so the silent-fall-through is the better trade-off.
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n" },
        docs: { "page.md": "Malformed `src/app.ts:1#42abc` falls through.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("anchor `42abc`");
    });

    // Trailing-period regression tests (#158 iter-2 [H1] / [M1]): an
    // over-broad lookahead would silently drop range bounds or anchors
    // when a citation is followed by sentence punctuation. These lock
    // the gate's behaviour against that regression in both backtick'd
    // (typical) and bare (rare but legal in prose) shapes.
    it("matches an anchorless single-line citation followed by `.` (regression: H1 over-broad lookahead)", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\n" },
        docs: { "page.md": "See src/app.ts:2. Done.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("still flags an out-of-range end on a range citation followed by `.` (range end must not be silently dropped)", () => {
      const root = makeFixture({
        src: { "app.ts": "a\nb\nc\n" },
        docs: { "page.md": "Bad: src/app.ts:1-99. End out of range.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("end line 99 out of range");
    });

    it("still verifies the anchor on an anchored range citation followed by `.` (anchor must not be silently dropped)", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\n" },
        docs: { "page.md": "Bad: src/app.ts:1-3#missingSym. Symbol absent.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `missingSym` not found on cited lines 1-3");
    });

    it("matches the same three shapes wrapped in backticks (positive control)", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\nexport function sym() {}\n" },
        docs: {
          "page.md": "OK: `src/app.ts:2`. OK: `src/app.ts:1-3`. OK: `src/app.ts:4#sym`.\n",
        },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("captures `$`-suffixed identifiers as the full anchor (regression: `\\b` would truncate)", () => {
      // `\b` is a word boundary against `\w = [A-Za-z0-9_]`, so it treats
      // `$` as non-word. A `\b` after the anchor group silently truncates
      // `#foo$` to `foo`. The negative-lookahead form preserves the full
      // identifier so `count$` (common with reactive-style suffixes) is
      // checked correctly. The fixture omits `count$` from the cited
      // line so the gate must fail with the full identifier in the
      // error message, proving the suffix was captured.
      const root = makeFixture({
        src: { "app.ts": "// line1\nconst other = 1;\n" },
        docs: { "page.md": "See `src/app.ts:2#count$` for the stream.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `count$` not found on cited line 2");
    });

    it("accepts a single-line anchored citation on the exact symbol line (slice boundary)", () => {
      // Pins the off-by-one edge in `readLineRange` (slice(start-1, end)):
      // start === end, citing the exact symbol line.
      const root = makeFixture({
        src: { "app.ts": "// l1\n// l2\n// l3\nexport function buildPrompt() {}\n" },
        docs: { "page.md": "See `src/app.ts:4#buildPrompt`.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("accepts dotted member-expression anchors (`#Foo.bar`)", () => {
      const root = makeFixture({
        src: { "app.ts": "// l1\nexport const Foo = { bar: () => 1 };\nFoo.bar();\n" },
        docs: { "page.md": "See `src/app.ts:3#Foo.bar` for the call site.\n" },
      });
      fixtures.push(root);
      const { exitCode, stdout } = runScript(root);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("OK: every src/<path>:<line> citation");
    });

    it("rejects a dotted anchor when only the prefix is present on the cited line", () => {
      // Closes the silent-truncation hole: `#Foo.bar` must not falsely
      // pass when only `Foo` appears at the cited line.
      const root = makeFixture({
        src: { "app.ts": "// l1\nclass Foo {}\n" },
        docs: { "page.md": "Bad: `src/app.ts:2#Foo.bar`, only Foo here.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `Foo.bar` not found on cited line 2");
    });

    it("does not match `#Foo.bar` inside a longer chain like `obj.Foo.bar`", () => {
      // Dotted anchors must bind to a chain root, not a tail-substring of
      // a deeper expression, otherwise the anchor false-positives on any
      // line that incidentally ends with the same suffix.
      const root = makeFixture({
        src: { "app.ts": "// l1\nconst x = obj.Foo.bar();\n" },
        docs: { "page.md": "See `src/app.ts:2#Foo.bar`.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("anchor `Foo.bar` not found");
    });

    it("honours `#symbol` anchors in root-level docs (CLAUDE.md), not just docs/", () => {
      // Confirms the anchor path is file-location-independent: the gate
      // widening in PR #138 swept root-level docs into scope, and #158
      // anchor support must apply uniformly.
      const root = makeFixture({
        src: { "app.ts": "// l1\nexport function buildPrompt() {}\n" },
        rootDocs: { "CLAUDE.md": "Stale: `src/app.ts:1#buildPrompt` cites wrong line.\n" },
      });
      fixtures.push(root);
      const { exitCode, stderr } = runScript(root);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("CLAUDE.md:1");
      expect(stderr).toContain("anchor `buildPrompt` not found on cited line 1");
    });
  });
});
