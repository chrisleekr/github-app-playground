#!/usr/bin/env bun
/**
 * CI guard: every `src/<path>:<line>` (or `:<start>-<end>`) citation in
 * docs/, plus root-level README.md, CONTRIBUTING.md and CLAUDE.md,
 * points at a file that exists and a line range that is in bounds.
 *
 * Catches the silent-rot case where a refactor shifts line numbers but
 * the doc keeps citing the old offset. We only flag citations that
 * include a `:line` suffix: bare `src/foo.ts` pointers (e.g. "see
 * `src/app.ts`") are explicitly out of scope; they don't claim a line
 * and can't go stale on a line-shift.
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

// Match `src/<path>.<ext>:<line>` or `:<start>-<end>`. Path may include
// `[A-Za-z0-9_./-]`; extension is one of the source-code extensions we
// actually cite. `:<line>` is required; bare paths are ignored.
const CITATION_RE = /\bsrc\/([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|mjs|cjs|js)):(\d+)(?:-(\d+))?\b/g;

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
        const start = Number.parseInt(startStr, 10);
        const end = endStr === undefined ? start : Number.parseInt(endStr, 10);
        const citation =
          endStr === undefined ? `${relPath}:${startStr}` : `${relPath}:${startStr}-${endStr}`;
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
    "\nFix: update the citation to the current line range, or drop the `:<line>` suffix if the file no longer needs an anchor.",
  );
  process.exit(1);
}

main();
