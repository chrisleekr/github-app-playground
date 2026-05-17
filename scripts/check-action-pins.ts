#!/usr/bin/env bun
/**
 * CI guard: every third-party GitHub Action referenced by `uses:` in
 * .github/workflows/ is pinned to a full 40-character commit SHA, not a
 * mutable Git tag. A tag (even `vX.Y.Z`) can be force-moved by anyone who
 * can push to the action's repo, so the bytes a runner executes are decided
 * at run time, not at review time (CVE-2025-30066, tj-actions/changed-files).
 * A commit SHA is immutable. See issue #137.
 *
 * Local reusable-workflow calls (`uses: ./...`) are exempt: they are
 * same-repo paths with no upstream tag an attacker could move.
 *
 * Scope: this scans block-style `uses:` keys (the only form in this repo's
 * workflows). Flow-mapping steps (`- {uses: ...}`) are not parsed; if that
 * form is ever introduced, extend `USES_RE` and add a fixture.
 *
 * Exit 0 when every reference is SHA-pinned, 1 otherwise with a per-line
 * report on stderr.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `ACTION_PINS_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["ACTION_PINS_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(repoRoot, ".github", "workflows");

// `uses:` line, capturing the action reference as the first whitespace-
// delimited token. `\S+` stops at the first space, so a trailing
// `# vX.Y.Z` version comment is naturally excluded from the capture.
const USES_RE = /^\s*(?:-\s*)?uses:\s*(\S+)/;
// A pinned ref ends with `@` then exactly 40 hex chars (the commit SHA).
const SHA_RE = /@[0-9a-fA-F]{40}$/;

interface Violation {
  file: string;
  line: number;
  ref: string;
}

function workflowFiles(): string[] {
  let entries: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
    entries = readdirSync(WORKFLOW_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".yml") || e.endsWith(".yaml"))
    .map((e) => join(WORKFLOW_DIR, e));
}

function checkFile(path: string): Violation[] {
  const out: Violation[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated from .github/workflows/
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Skip fully commented-out lines (e.g. a disabled `#   uses: foo@v1`).
    if (line.trimStart().startsWith("#")) continue;
    const match = USES_RE.exec(line);
    if (match === null) continue;
    // Strip surrounding quotes: `uses: "owner/action@<sha>"` is legal YAML
    // and must not be reported as unpinned just for the quote characters.
    const ref = (match[1] as string).replace(/^["']|["']$/g, "");
    // Local reusable-workflow call: same-repo path, nothing to pin.
    if (ref.startsWith("./") || ref.startsWith("../")) continue;
    if (!SHA_RE.test(ref)) {
      out.push({ file: relative(repoRoot, path), line: i + 1, ref });
    }
  }
  return out;
}

function main(): void {
  const violations = workflowFiles().flatMap(checkFile);
  if (violations.length === 0) {
    console.log(
      "OK: every third-party `uses:` in .github/workflows/ is pinned to a 40-char commit SHA",
    );
    return;
  }
  console.error(`ERROR: ${String(violations.length)} GitHub Action reference(s) not SHA-pinned:\n`);
  for (const v of violations) {
    console.error(`  - ${v.file}:${String(v.line)} uses \`${v.ref}\``);
  }
  console.error(
    "\nFix: replace the tag with the commit SHA it resolves to, e.g.\n" +
      "  uses: owner/action@<40-char-sha> # vX.Y.Z\n" +
      "Resolve with: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha",
  );
  process.exit(1);
}

main();
