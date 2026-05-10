#!/usr/bin/env bun
/**
 * CI dependency-audit gate.
 *
 * Why this wrapper exists:
 *   `bun audit` exits 1 on ANY advisory regardless of --audit-level
 *   (verified against https://bun.com/docs/install/audit). That blocks
 *   unrelated PRs every time a moderate transitive advisory lands. This
 *   wrapper restores severity-based gating: block on high+critical, warn
 *   on moderate+low, with an inline GHSA allowlist for known-accepted
 *   findings.
 *
 * Allowlist convention: every entry MUST have an `expires` so it gets
 * re-reviewed. Mirrors the .trivyignore.yaml convention. Expired entries
 * become warnings on the next run.
 */

interface BunAuditAdvisory {
  id?: number;
  module_name?: string;
  severity?: "low" | "moderate" | "high" | "critical";
  title?: string;
  url?: string;
  github_advisory_id?: string;
  cves?: string[];
}

interface BunAuditReport {
  advisories?: Record<string, BunAuditAdvisory>;
}

interface AllowEntry {
  ghsa: string;
  reason: string;
  expires: string; // ISO date
}

const IGNORED: AllowEntry[] = [
  // Example:
  // { ghsa: "GHSA-xxxx-xxxx-xxxx", reason: "...", expires: "2026-06-01" },
];

const proc = Bun.spawnSync({
  cmd: ["bun", "audit", "--json"],
  stdout: "pipe",
  stderr: "pipe",
});

const stdout = new TextDecoder().decode(proc.stdout).trim();
const stderr = new TextDecoder().decode(proc.stderr).trim();

if (!stdout) {
  // Empty stdout + non-zero exit = bun audit failed to run (network error,
  // registry outage, Bun bug). Treating this as "no advisories" would
  // silently disable the audit gate; fail closed instead.
  if (proc.exitCode !== 0 && proc.exitCode !== null) {
    console.error(`::error::bun audit exited with code ${proc.exitCode} and produced no JSON.`);
    if (stderr) console.error(stderr);
    process.exit(proc.exitCode);
  }
  console.log("bun audit produced no JSON output (no advisories).");
  if (stderr) console.error(stderr);
  process.exit(0);
}

let report: BunAuditReport;
try {
  report = JSON.parse(stdout);
} catch (err) {
  console.error("Failed to parse bun audit JSON:");
  console.error(err);
  console.error("--- raw stdout ---");
  console.error(stdout);
  if (stderr) {
    console.error("--- raw stderr ---");
    console.error(stderr);
  }
  process.exit(1);
}

const advisories = Object.values(report.advisories ?? {});
const now = new Date();

function lookupAllow(ghsa: string): AllowEntry | null {
  const entry = IGNORED.find((e) => e.ghsa === ghsa);
  if (!entry) return null;
  // Enforce YYYY-MM-DD so we can append an end-of-day time deterministically.
  // `new Date("2026-04-30")` resolves to 00:00:00Z, so the entry would be
  // considered expired for the whole day. Treat the expiry as valid through
  // 23:59:59.999 UTC of the stated day instead.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} has invalid expires date (want YYYY-MM-DD): ${entry.expires}`,
    );
    return null;
  }
  const expiresAt = new Date(`${entry.expires}T23:59:59.999Z`);
  if (Number.isNaN(expiresAt.getTime())) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} has invalid expires date: ${entry.expires}`,
    );
    return null;
  }
  if (expiresAt < now) {
    console.warn(
      `::warning::Allowlist entry for ${ghsa} expired ${entry.expires}, must re-review.`,
    );
    return null;
  }
  return entry;
}

let blocking = 0;
let warning = 0;
let ignored = 0;

for (const a of advisories) {
  const ghsa = a.github_advisory_id ?? "";
  const allow = ghsa ? lookupAllow(ghsa) : null;
  const sev = a.severity ?? "low";
  const id = ghsa || `id=${a.id ?? "?"}`;
  const where = a.module_name ?? "(unknown module)";
  const title = a.title ?? "(no title)";

  if (allow) {
    console.log(
      `::notice::Ignored ${id} (${sev}) ${where}: ${title}, ${allow.reason} (expires ${allow.expires})`,
    );
    ignored++;
    continue;
  }

  if (sev === "high" || sev === "critical") {
    console.log(`::error::${sev.toUpperCase()} ${id} ${where}: ${title}`);
    if (a.url) console.log(`  ${a.url}`);
    blocking++;
  } else {
    console.log(`::warning::${sev} ${id} ${where}: ${title}`);
    if (a.url) console.log(`  ${a.url}`);
    warning++;
  }
}

console.log(
  `\nSummary: blocking=${blocking} warning=${warning} ignored=${ignored} total=${advisories.length}`,
);

process.exit(blocking > 0 ? 1 : 0);
