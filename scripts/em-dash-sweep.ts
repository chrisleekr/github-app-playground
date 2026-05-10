#!/usr/bin/env bun
/**
 * Em-dash sweep + CI gate.
 *
 * Modes:
 *   bun scripts/em-dash-sweep.ts <path> [<path> ...]   # rewrite files in place
 *   bun scripts/em-dash-sweep.ts --check               # exit 1 if any in-scope file contains U+2014
 *
 * Heuristic (applied per line in this priority order):
 *   1. Markdown table empty cell  |  —  |   ->  | _none_ |
 *   2. Heading line (^#+ ...)     —  ->  : (first hit only)
 *   3. Bullet term definition    ^\s*[-*]\s+TERM — EXPL  ->  TERM: EXPL
 *   4. Default                    —  ->  ,
 *   5. No-space                  a—b           ->  a-b
 *
 * After step 5, any remaining — is reported and the file is left
 * untouched; the human resolves it.
 *
 * Skip list (hard-coded so the gate stays trustworthy):
 *   specs/**, src/db/migrations/**, CHANGELOG.md,
 *   test/**\/fixtures/**, node_modules/**, .git/**,
 *   this script itself.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const EM = "—";
const SCRIPT_REL = relative(REPO_ROOT, import.meta.path);

const SKIP_PATTERNS: RegExp[] = [
  /^specs\//,
  /^src\/db\/migrations\//,
  /^CHANGELOG\.md$/,
  /^test\/.*\/fixtures\//,
  /(^|\/)node_modules\//,
  /^\.git\//,
  /^dist\//,
  /^coverage\//,
  /^site\//,
  new RegExp(`^${SCRIPT_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
];

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".yml",
  ".yaml",
  ".json",
  ".jsonc",
  ".sql",
  ".sh",
  ".fish",
  ".bash",
  ".html",
  ".css",
  ".toml",
  ".env",
]);

type Result = {
  path: string;
  before: number;
  after: number;
  unresolved: { line: number; text: string }[];
};

function isSkipped(rel: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(rel));
}

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // No extension (e.g. Dockerfile, Makefile)
  if (ext === "") {
    const base = path.split("/").pop() ?? "";
    if (/^(Dockerfile|Makefile|README|CONTRIBUTING|LICENSE)/i.test(base)) return true;
  }
  return false;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(REPO_ROOT, full);
    if (isSkipped(rel)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && isTextFile(full)) yield full;
  }
}

function transformLine(line: string): string {
  // Rule 1: markdown table empty cell  |  —  |  -> | _none_ |
  // Apply to every cell on the line (the table row may have multiple).
  line = line.replace(/\|\s*—\s*\|/g, "| _none_ |");
  // The above only catches non-overlapping matches. A row like `| — | — |`
  // leaves the middle pipe shared, so re-run once.
  line = line.replace(/\|\s*—\s*\|/g, "| _none_ |");

  // Rule 2: heading line  -> first ` — ` becomes ': '
  if (/^\s*#{1,6}\s/.test(line) && line.includes(` ${EM} `)) {
    line = line.replace(` ${EM} `, ": ");
  }

  // Rule 3: bullet/list term definition
  //   ^\s*[-*+]\s+TERM — EXPL  ->  TERM: EXPL
  // TERM may contain inline code/backticks/parens but not a literal newline.
  // Only the FIRST ` — ` on the bullet line is treated as the definition
  // separator; later em dashes in the explanation fall through to rule 4.
  {
    const m = line.match(/^(\s*[-*+]\s+)(.*?) — (.*)$/);
    if (m) line = `${m[1]}${m[2]}: ${m[3]}`;
  }

  // Rule 4: default ` — ` -> `, `
  line = line.replaceAll(` ${EM} `, ", ");

  // Rule 5: no-space `a—b` -> `a-b` (only when both sides are word chars)
  line = line.replace(/(\w)—(\w)/g, "$1-$2");

  return line;
}

function processFile(path: string, write: boolean): Result {
  const original = readFileSync(path, "utf8");
  const beforeCount = (original.match(/—/g) ?? []).length;
  if (beforeCount === 0) {
    return { path, before: 0, after: 0, unresolved: [] };
  }
  const lines = original.split("\n");
  const out: string[] = [];
  for (const line of lines) out.push(transformLine(line));
  const next = out.join("\n");
  const afterCount = (next.match(/—/g) ?? []).length;
  const unresolved: Result["unresolved"] = [];
  if (afterCount > 0) {
    out.forEach((l, i) => {
      if (l.includes(EM)) unresolved.push({ line: i + 1, text: l });
    });
  }
  if (write && next !== original) writeFileSync(path, next);
  return { path, before: beforeCount, after: afterCount, unresolved };
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const targets = args.filter((a) => !a.startsWith("--"));

  const files: string[] = [];
  if (checkMode || targets.length === 0) {
    for (const f of walk(REPO_ROOT)) files.push(f);
  } else {
    for (const t of targets) {
      const abs = resolve(t);
      const st = statSync(abs);
      if (st.isDirectory()) {
        for (const f of walk(abs)) files.push(f);
      } else if (isTextFile(abs) && !isSkipped(relative(REPO_ROOT, abs))) {
        files.push(abs);
      }
    }
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let touched = 0;
  const unresolvedFiles: Result[] = [];

  for (const f of files) {
    const r = processFile(f, !checkMode);
    if (r.before > 0) {
      totalBefore += r.before;
      totalAfter += r.after;
      if (!checkMode && r.before !== r.after) touched++;
      if (r.after > 0) unresolvedFiles.push(r);
    }
  }

  if (checkMode) {
    if (totalBefore > 0) {
      console.error(
        `em-dash check: FAIL (${totalBefore} occurrences across ${unresolvedFiles.length} files)`,
      );
      for (const f of unresolvedFiles) {
        console.error(`  ${relative(REPO_ROOT, f.path)}: ${f.before}`);
        for (const u of f.unresolved.slice(0, 3)) {
          console.error(`    L${u.line}: ${u.text.trim().slice(0, 120)}`);
        }
      }
      process.exit(1);
    }
    console.log("em-dash check: OK (zero occurrences in scope)");
    return;
  }

  console.log(`em-dash sweep: rewrote ${totalBefore - totalAfter} occurrences in ${touched} files`);
  if (unresolvedFiles.length > 0) {
    console.log(`unresolved (heuristic could not handle, ${totalAfter} total):`);
    for (const f of unresolvedFiles) {
      console.log(`  ${relative(REPO_ROOT, f.path)}: ${f.after}`);
      for (const u of f.unresolved.slice(0, 5)) {
        console.log(`    L${u.line}: ${u.text.trim().slice(0, 140)}`);
      }
    }
  }
}

main();
