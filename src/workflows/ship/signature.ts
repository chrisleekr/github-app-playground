/**
 * Failure-signature derivation (T038, FR-013, research.md R4).
 *
 * Two-tier strategy:
 *   Tier 1: extract a normalised error string from the check output.
 *            Strips line/column numbers, repo-prefixed paths, ANSI
 *            escapes. Same lint rule on different lines/files → same
 *            signature, so the fix-attempts ledger correctly counts
 *            "we already tried fixing this rule N times."
 *   Tier 2: fallback when Tier 1 yields nothing extractable. Hashes
 *            (check_name, conclusion, last_50_lines_normalised) so we
 *            still distinguish OOM-killed Docker builds from a
 *            no-output failure.
 *
 * Pure function: no DB, no network. Consumed by `fix-attempts.ts`
 * (T039) for the cap check.
 */

import { createHash } from "node:crypto";

export interface SignatureInput {
  readonly checkName: string;
  readonly conclusion: string | null;
  /** Raw check output (logs / annotations / summary). */
  readonly logs: string;
}

export interface DerivedSignature {
  readonly signature: string;
  readonly tier: 1 | 2;
}

// eslint-disable-next-line no-control-regex -- intentional ESC byte match
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
const LINE_COL = /:\d+:\d+(?::\d+)?/g;
const ABSOLUTE_PATH = /\/[A-Za-z0-9_./@-]+\.[A-Za-z]+/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const HEX_SHA = /\b[0-9a-f]{7,40}\b/g;
const TRAILING_WS = /[ \t]+$/gm;

/**
 * Tier-1 patterns: each entry exposes one stable capture group that
 * encodes the lint/type class only (rule id, error code, error class).
 * Volatile message text (variable names, paths, source snippets) is
 * matched but not captured, so two failures of the same rule on
 * different lines/files share a signature and the fix-attempts ledger
 * counts retries correctly.
 */
interface Tier1Pattern {
  readonly re: RegExp;
  readonly stableGroup: number;
}

const TIER1_PATTERNS: readonly Tier1Pattern[] = [
  // ESLint: "  10:5  error  Unexpected console statement  no-console"
  // Captures only the rule id (group 1); the human-readable message is
  // matched as `.+?` but not captured. The optional `@scope/` prefix
  // covers scoped rules like `@typescript-eslint/no-unused-vars`.
  {
    re: /\b(?:error|warning)\s+.+?\s+((?:@[a-z0-9-]+\/)?[a-z0-9-]+(?:\/[a-z0-9-]+)?)\s*$/im,
    stableGroup: 1,
  },
  // TypeScript: "src/x.ts(10,5): error TS2304: Cannot find name 'foo'."
  // Captures only the TS error code; the explanatory text is dropped.
  { re: /\berror\s+(TS\d+):\s+.+?$/im, stableGroup: 1 },
  // Prettier: "[error] src/x.ts: SyntaxError: Unexpected token (10:5)"
  // Captures only the error class.
  { re: /\[error\]\s+.+?:\s+(\w+):\s+.+?(?:\s+\(\d+:\d+\))?$/im, stableGroup: 1 },
  // Bun test: "  AssertionError: expected ..."
  // The assertion text itself is the stable signal here.
  { re: /AssertionError:\s+(.+?)$/im, stableGroup: 1 },
];

function normalise(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(TIMESTAMP, "<TS>")
    .replace(HEX_SHA, "<SHA>")
    .replace(LINE_COL, "")
    .replace(ABSOLUTE_PATH, "<PATH>")
    .replace(TRAILING_WS, "")
    .toLowerCase();
}

function tryExtractTier1(text: string): string | null {
  for (const { re, stableGroup } of TIER1_PATTERNS) {
    const match = re.exec(text);
    const key = match?.[stableGroup]?.trim();
    if (key !== undefined && key !== "") return key;
  }
  return null;
}

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function deriveSignature(input: SignatureInput): DerivedSignature {
  const normalised = normalise(input.logs);
  const tier1 = tryExtractTier1(normalised);
  if (tier1 !== null && tier1.trim() !== "") {
    return { signature: `t1:${input.checkName}:${sha256(tier1)}`, tier: 1 };
  }
  const tail = normalise(lastLines(input.logs, 50));
  const conclusion = input.conclusion ?? "<null>";
  return {
    signature: `t2:${input.checkName}:${conclusion}:${sha256(tail)}`,
    tier: 2,
  };
}
