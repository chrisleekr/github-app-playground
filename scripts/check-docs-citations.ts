#!/usr/bin/env bun
/**
 * CI guard: every `src/<path>:<line>` (or `:<start>-<end>`) citation in
 * docs/, plus root-level README.md, CONTRIBUTING.md and CLAUDE.md,
 * points at a file that exists and a line range that is in bounds.
 *
 * Citations may opt in to symbol anchoring with a trailing `#symbol`
 * suffix (e.g. `` `src/foo.ts:42#bar` ``). When the anchor is present, at
 * least one line in the cited range must physically contain the anchor
 * token; otherwise the citation falls back to today's bounds-only check.
 * Anchors are opt-in per citation, so no flag day is required. The anchor
 * grammar is an ASCII identifier token (letters, digits, `_`, `$`),
 * optionally extended with dotted member accessors (e.g. `#Foo.bar.baz`),
 * so a citation can pin a method on a specific receiver. Unicode
 * identifiers and hyphenated names are not supported; cite the rightmost
 * dotted chain instead. The anchor asserts textual presence on the cited
 * line range only, it does not distinguish a definition from a comment
 * or call site, the bounds-only path is the line-shift guard, the anchor
 * is the symbol-rename guard.
 *
 * Without an anchor, the gate only catches the loud refactor-shift case
 * where the new line falls past the end of the file. Anchored citations
 * also catch the silent case where the symbol moved inside the file but
 * the doc kept citing the old offset.
 *
 * Bare `src/foo.ts` pointers (e.g. "see `src/app.ts`") are explicitly
 * out of scope: they don't claim a line and can't go stale on a shift.
 *
 * Exit 0 on clean, 1 on any broken citation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `DOCS_CHECK_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["DOCS_CHECK_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ROOT = join(repoRoot, "docs");
// Root-level Markdown that ships outside docs/ but cites src/ all the same.
const ROOT_DOCS = ["README.md", "CONTRIBUTING.md", "CLAUDE.md"];

// Match `src/<path>.<ext>:<line>` or `:<start>-<end>`, with an optional
// trailing `#symbol` anchor. Path may include `[A-Za-z0-9_./-]`; extension
// is one of the source-code extensions we actually cite. `:<line>` is
// required; bare paths are ignored. The anchor is an ASCII identifier
// token, optionally extended with dotted accessors (`Foo.bar.baz`); the
// leading char of each segment is letter / `_` / `$`, so leading digits
// can't start an anchor. The trailing negative lookahead
// `(?![A-Za-z0-9_$])` is required (not `\b`) because `$` is not a regex
// word character: a plain `\b` after the anchor would silently truncate
// `#foo$` to `foo`. The lookahead deliberately does NOT include `.` or
// `#`, so a citation followed by sentence punctuation (`src/a.ts:1.`)
// or a malformed anchor (`src/a.ts:1#42abc`, which can't bind a leading
// digit and falls through anchorlessly) still parses as the bounds-only
// citation it would on `main`.
const CITATION_RE =
  /\bsrc\/([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|mjs|cjs|js)):(\d+)(?:-(\d+))?(?:#([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*))?(?![A-Za-z0-9_$])/g;

interface BrokenCitation {
  docFile: string;
  docLine: number;
  citation: string;
  reason: string;
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- traversal of repo-controlled path
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constructed from repo-controlled name
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (st.isFile() && entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Markdown files in scope: everything under docs/ plus the root-level docs
// listed in `ROOT_DOCS` that actually exist (a missing one is skipped so the
// gate stays portable if a file is later removed).
function collectMarkdownFiles(): string[] {
  const out = walkMarkdown(DOCS_ROOT);
  for (const name of ROOT_DOCS) {
    const full = join(repoRoot, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant repo-root names
    if (existsSync(full)) out.push(full);
  }
  return out;
}

function fileLineCount(absPath: string): number {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is constructed from a regex-matched repo-relative path; existence is checked by caller
  const buf = readFileSync(absPath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
  // Files that don't end with a newline still have a final non-empty line.
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) count++;
  return count;
}

// Extracts the [start, end] (1-based, inclusive) slice of `absPath` as a
// single string. Caller is responsible for ensuring the range is in bounds.
function readLineRange(absPath: string, start: number, end: number): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is constructed from a regex-matched repo-relative path; bounds checked by caller
  const text = readFileSync(absPath, "utf-8");
  const lines = text.split("\n");
  // `split("\n")` on a trailing-newline file yields an extra empty element;
  // slice(start-1, end) is still correct because we never read past `total`.
  return lines.slice(start - 1, end).join("\n");
}

// Anchor matches must be whole-word so `buildPrompt` doesn't match
// `buildPromptParts`, and a dotted anchor like `Foo.bar` must not match
// inside a longer chain like `obj.Foo.bar`. We bound the token with
// characters that are neither identifier chars nor `.` on each side. `$`
// and `.` are regex metacharacters so we escape them before interpolation;
// CITATION_RE's anchor group only permits `[A-Za-z0-9_$.]`, of which
// those two are the only metacharacters.
function anchorPresent(haystack: string, anchor: string): boolean {
  const escaped = anchor.replace(/[$.]/g, (c) => `\\${c}`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- anchor is restricted to [A-Za-z0-9_$.] by CITATION_RE and metacharacters are escaped above
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$.])${escaped}(?:[^A-Za-z0-9_$.]|$)`);
  return re.test(haystack);
}

function fileExists(absPath: string): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is repo-relative path constructed from regex match
    return statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function check(): BrokenCitation[] {
  const broken: BrokenCitation[] = [];
  for (const md of collectMarkdownFiles()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated from docs/ and ROOT_DOCS
    const contents = readFileSync(md, "utf-8");
    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      CITATION_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CITATION_RE.exec(line)) !== null) {
        const relPath = `src/${match[1] ?? ""}`;
        const startStr = match[2] as string;
        const endStr = match[3];
        const anchor = match[4];
        const start = Number.parseInt(startStr, 10);
        const end = endStr === undefined ? start : Number.parseInt(endStr, 10);
        const rangeStr = endStr === undefined ? startStr : `${startStr}-${endStr}`;
        const anchorSuffix = anchor === undefined ? "" : `#${anchor}`;
        const citation = `${relPath}:${rangeStr}${anchorSuffix}`;
        // Reject `..` segments. `CITATION_RE` allows them in the path
        // component, so a doc citing `src/../foo.ts:1` would otherwise
        // statSync a path that escapes `src/` and report "OK" for a
        // citation that no longer points into the source tree.
        if (relPath.split("/").includes("..")) {
          broken.push({
            docFile: relative(repoRoot, md),
            docLine: i + 1,
            citation,
            reason: `path contains a \`..\` segment, citations must point inside src/`,
          });
          continue;
        }
        const abs = join(repoRoot, relPath);
        if (!fileExists(abs)) {
          broken.push({
            docFile: relative(repoRoot, md),
            docLine: i + 1,
            citation,
            reason: `file does not exist`,
          });
          continue;
        }
        const total = fileLineCount(abs);
        if (start < 1 || start > total) {
          broken.push({
            docFile: relative(repoRoot, md),
            docLine: i + 1,
            citation,
            reason: `start line ${String(start)} out of range (file has ${String(total)} lines)`,
          });
          continue;
        }
        if (end < start || end > total) {
          broken.push({
            docFile: relative(repoRoot, md),
            docLine: i + 1,
            citation,
            reason: `end line ${String(end)} out of range (file has ${String(total)} lines)`,
          });
          continue;
        }
        // Anchor verification: if the citation declared an expected symbol,
        // assert the cited range actually contains that token. This is the
        // silent-rot guard the bounds-only path can't provide.
        if (anchor !== undefined) {
          const slice = readLineRange(abs, start, end);
          if (!anchorPresent(slice, anchor)) {
            broken.push({
              docFile: relative(repoRoot, md),
              docLine: i + 1,
              citation,
              reason: `anchor \`${anchor}\` not found on cited line${start === end ? "" : "s"} ${rangeStr} of \`${relPath}\``,
            });
            // Trailing `continue` is defensive: keeps the per-citation
            // failure pattern uniform with the earlier checks, so any
            // future check appended below doesn't double-report a
            // citation that's already on `broken`.
            continue;
          }
        }
      }
    }
  }
  return broken;
}

function main(): void {
  const broken = check();
  if (broken.length === 0) {
    console.log("OK: every src/<path>:<line> citation points at an in-range location");
    return;
  }
  console.error(`ERROR: ${String(broken.length)} stale src citation(s):\n`);
  for (const b of broken) {
    console.error(`  - ${b.docFile}:${String(b.docLine)} cites \`${b.citation}\`, ${b.reason}`);
  }
  console.error(
    "\nFix: update the citation to the current line range, drop the `:<line>` suffix if the file no longer needs an anchor, or correct the `#symbol` suffix (anchors are optional but, when present, must appear on the cited line).",
  );
  process.exit(1);
}

main();
