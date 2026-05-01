/**
 * T046b: static guard for FR-009 — refuses to ship code that could
 * push --force, reset --hard, delete branches, rewrite history, or
 * call any merge API from inside the ship workflow.
 *
 * Wired into `bun run check`. Greps every `.ts` file under the
 * ship-relevant subtrees for forbidden literal strings. False positives
 * (test fixtures, JSDoc that mentions the prohibition) are addressed by
 * keeping the patterns specific.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// T046b scope: the NEW ship_intents lifecycle code under
// `src/workflows/ship/`. Legacy handlers under `src/workflows/handlers/`
// embed agent prompt strings that DOCUMENT what the agent must not do
// (e.g., "NEVER call `gh pr merge`"); those documentation lines must
// not trigger the guard. The runtime test in T046a covers the legacy
// handlers via mocked tool-call recorders.
//
// US3 extension (specs/20260429-212559-ship-iteration-wiring T035):
// the four daemon-side scoped executors live under `src/daemon/` —
// outside the ship-workflow tree but governed by the same FR-009
// prohibitions. Including them as explicit file roots keeps the scan
// noise-free (other `src/daemon/` files embed agent prompts that
// document `--force` semantics legitimately).
const SCAN_ROOTS = ["src/workflows/ship"];
const SCAN_FILES = [
  "src/daemon/scoped-rebase-executor.ts",
  "src/daemon/scoped-fix-thread-executor.ts",
  "src/daemon/scoped-explain-thread-executor.ts",
  "src/daemon/scoped-open-pr-executor.ts",
];

const FORBIDDEN: { readonly pattern: RegExp; readonly description: string }[] = [
  { pattern: /git\s+push\s+--force(?!-with-lease-if)/i, description: "git push --force" },
  { pattern: /git\s+push\s+--force-with-lease/i, description: "git push --force-with-lease" },
  { pattern: /git\s+push\s+-f\b/i, description: "git push -f" },
  { pattern: /git\s+push\s+\+/, description: "git push with + force-refspec" },
  { pattern: /git\s+push\s+--mirror/i, description: "git push --mirror" },
  { pattern: /git\s+reset\s+--hard\b/i, description: "git reset --hard" },
  { pattern: /git\s+branch\s+-D\b/i, description: "git branch -D" },
  { pattern: /git\s+push\b[^"\n]*\s--delete\b/i, description: "git push --delete" },
  { pattern: /git\s+filter-branch/i, description: "git filter-branch" },
  { pattern: /git\s+filter-repo/i, description: "git filter-repo" },
  { pattern: /git\s+replace\b/i, description: "git replace" },
  { pattern: /\bgh\s+pr\s+merge/i, description: "gh pr merge" },
  { pattern: /mergePullRequest\s*\(/, description: "mergePullRequest GraphQL mutation" },
  { pattern: /mergeBranch\s*\(/, description: "mergeBranch GraphQL mutation" },
];

function* walk(dir: string): Generator<string> {
  // Fail-closed: this is a CI safety guard. Swallowing readdir/stat errors
  // would let a missing or unreadable scan root report `clean` and silently
  // disable the check.
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (stat.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function scan(): { file: string; line: number; description: string; text: string }[] {
  const violations: { file: string; line: number; description: string; text: string }[] = [];
  const visited = new Set<string>();
  const fileIterables: Iterable<string>[] = SCAN_ROOTS.map((r) => walk(r));
  fileIterables.push(SCAN_FILES);
  for (const iter of fileIterables) {
    for (const file of iter) {
      if (visited.has(file)) continue;
      visited.add(file);
      // Skip self — this guard file documents the patterns it checks for.
      if (file.endsWith("check-no-destructive-actions.ts")) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // Skip pure JSDoc/comment lines that document the prohibition.
        const stripped = line.trim();
        if (stripped.startsWith("//") || stripped.startsWith("*")) continue;
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            violations.push({
              file,
              line: i + 1,
              description: rule.description,
              text: line.trim(),
            });
          }
        }
      }
    }
  }
  return violations;
}

const violations = scan();
if (violations.length > 0) {
  console.error("FR-009 destructive-action guard: violations found");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.description}`);
    console.error(`    ${v.text}`);
  }
  process.exit(1);
}
console.log(
  `FR-009 destructive-action guard: clean (${SCAN_ROOTS.length} roots, ${SCAN_FILES.length} files scanned)`,
);
