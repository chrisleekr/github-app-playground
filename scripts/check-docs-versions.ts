#!/usr/bin/env bun
/**
 * CI guard: every Bun version string in docs/ matches the canonical pin
 * in `.tool-versions`. Also asserts that `package.json` (engines.bun +
 * packageManager) and the two Dockerfiles agree, so the canonical pin is
 * authoritative across the repo.
 *
 * Detected forms in docs/**:
 *   - bare semver "1.3.13" inside a Bun context (preceding text contains
 *     the word `bun`, case-insensitive, anywhere in the same Markdown
 *     line — covers tables, prose, code fences) — to avoid false matches
 *     on unrelated semvers (e.g. Node 20.x, openssl pins).
 *   - `oven/bun:<ver>` references.
 *
 * Exit 0 on match, 1 on any mismatch with a per-file diff on stderr.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `DOCS_CHECK_REPO_ROOT` env override exists solely so the test suite can
// point the gate at a fixture tree without copying the script. Production
// invocations leave it unset and resolve `repoRoot` from the script's own
// location.
const repoRoot =
  process.env["DOCS_CHECK_REPO_ROOT"] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_VERSIONS = join(repoRoot, ".tool-versions");
const PACKAGE_JSON = join(repoRoot, "package.json");
const DOCKERFILES = [
  join(repoRoot, "Dockerfile.orchestrator"),
  join(repoRoot, "Dockerfile.daemon"),
];
const DOCS_ROOT = join(repoRoot, "docs");

const SEMVER = /\d+\.\d+\.\d+/;

interface Mismatch {
  file: string;
  line: number;
  found: string;
  context: string;
}

function readBunVersionFromToolVersions(): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  const contents = readFileSync(TOOL_VERSIONS, "utf-8");
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^bun\s+(\d+\.\d+\.\d+)$/.exec(line);
    if (match) return match[1] as string;
  }
  throw new Error(`${TOOL_VERSIONS}: no \`bun <semver>\` line found`);
}

function checkPackageJson(canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant path
  const raw = readFileSync(PACKAGE_JSON, "utf-8");
  const parsed = JSON.parse(raw) as {
    engines?: { bun?: string };
    packageManager?: string;
  };
  const out: Mismatch[] = [];
  const engines = parsed.engines?.bun;
  if (engines === undefined) {
    out.push({
      file: relative(repoRoot, PACKAGE_JSON),
      line: 0,
      found: "<missing>",
      context: "engines.bun",
    });
  } else {
    const enginesSemver = SEMVER.exec(engines)?.[0];
    if (enginesSemver !== canonical) {
      out.push({
        file: relative(repoRoot, PACKAGE_JSON),
        line: 0,
        found: engines,
        context: "engines.bun",
      });
    }
  }
  const pkgmgr = parsed.packageManager;
  if (pkgmgr === undefined) {
    out.push({
      file: relative(repoRoot, PACKAGE_JSON),
      line: 0,
      found: "<missing>",
      context: "packageManager",
    });
  } else {
    const pmSemver = SEMVER.exec(pkgmgr)?.[0];
    if (!pkgmgr.startsWith("bun@") || pmSemver !== canonical) {
      out.push({
        file: relative(repoRoot, PACKAGE_JSON),
        line: 0,
        found: pkgmgr,
        context: "packageManager",
      });
    }
  }
  return out;
}

function checkDockerfile(path: string, canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant paths above
  const contents = readFileSync(path, "utf-8");
  const lines = contents.split("\n");
  const out: Mismatch[] = [];
  let foundBase = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const baseMatch = /^FROM\s+oven\/bun:(\d+\.\d+\.\d+)\s+AS\s+base/.exec(line);
    if (baseMatch) foundBase = true;
    // Scan every `oven/bun:<ver>` occurrence on the line — the anchored FROM
    // check above only confirms the base stage exists; comments, ENV lines
    // and RUN snippets can also embed `oven/bun:<ver>` and rot independently
    // (e.g. `# /root is mode 700 in oven/bun:<ver>` in Dockerfile.daemon).
    OVEN_RE.lastIndex = 0;
    let ovenMatch: RegExpExecArray | null;
    while ((ovenMatch = OVEN_RE.exec(line)) !== null) {
      if (ovenMatch[1] !== canonical) {
        out.push({
          file: relative(repoRoot, path),
          line: i + 1,
          found: `oven/bun:${ovenMatch[1] ?? ""}`,
          context: line.trim(),
        });
      }
    }
  }
  if (!foundBase) {
    out.push({
      file: relative(repoRoot, path),
      line: 0,
      found: "<missing>",
      context: "no `FROM oven/bun:<ver> AS base` line",
    });
  }
  return out;
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

const OVEN_RE = /oven\/bun:(\d+\.\d+\.\d+)/g;
const BUN_SEMVER_RE = /(?<![\w.-])(\d+\.\d+\.\d+)(?![\w.-])/g;

function checkDocFile(path: string, canonical: string): Mismatch[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- enumerated from docs/
  const contents = readFileSync(path, "utf-8");
  const lines = contents.split("\n");
  const out: Mismatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    OVEN_RE.lastIndex = 0;
    let ovenMatch: RegExpExecArray | null;
    while ((ovenMatch = OVEN_RE.exec(line)) !== null) {
      if (ovenMatch[1] !== canonical) {
        out.push({
          file: relative(repoRoot, path),
          line: i + 1,
          found: `oven/bun:${ovenMatch[1] ?? ""}`,
          context: line.trim(),
        });
      }
    }
    if (!/bun/i.test(line)) continue;
    BUN_SEMVER_RE.lastIndex = 0;
    let semverMatch: RegExpExecArray | null;
    while ((semverMatch = BUN_SEMVER_RE.exec(line)) !== null) {
      const idx = semverMatch.index;
      const before = line.slice(Math.max(0, idx - 12), idx);
      // Skip the `oven/bun:<ver>` matches we already handled above.
      if (/oven\/bun:$/.test(before)) continue;
      const found = semverMatch[1] as string;
      if (found !== canonical) {
        out.push({
          file: relative(repoRoot, path),
          line: i + 1,
          found,
          context: line.trim(),
        });
      }
    }
  }
  return out;
}

function main(): void {
  const canonical = readBunVersionFromToolVersions();
  const mismatches: Mismatch[] = [];
  mismatches.push(...checkPackageJson(canonical));
  for (const df of DOCKERFILES) mismatches.push(...checkDockerfile(df, canonical));
  for (const md of walkMarkdown(DOCS_ROOT)) mismatches.push(...checkDocFile(md, canonical));

  if (mismatches.length === 0) {
    console.log(
      `OK: every Bun version reference matches .tool-versions canonical \`${canonical}\``,
    );
    return;
  }

  console.error(
    `ERROR: ${String(mismatches.length)} Bun version reference(s) disagree with .tool-versions canonical \`${canonical}\`:\n`,
  );
  for (const m of mismatches) {
    const loc = m.line > 0 ? `${m.file}:${String(m.line)}` : m.file;
    console.error(`  - ${loc} [${m.context}] found \`${m.found}\`, expected \`${canonical}\``);
  }
  console.error(
    "\nFix: update each above to match `.tool-versions`, or bump `.tool-versions` and rerun.",
  );
  process.exit(1);
}

main();
