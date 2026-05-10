/**
 * Helpers for parsing the agent-authored RESOLVE.md artefact.
 *
 * The resolve handler's post-pipeline gate reads the `## Outstanding` section
 * populated by the agent when CI failures survive the per-iteration cap,
 * to surface what's left in the tracking comment. Kept in its own module so
 * the parser can be unit-tested without booting the rest of the handler.
 */

/**
 * Extract the body of the `## Outstanding` section from a RESOLVE.md report.
 *
 * Returns `null` when the section is missing, present-but-empty, or contains
 * only whitespace. The parser is heading-shape tolerant: any next `##`-level
 * heading terminates the section, regardless of its content.
 */
export function parseOutstandingSection(report: string | undefined | null): string | null {
  if (report === undefined || report === null || report.length === 0) return null;
  const lines = report.split(/\r?\n/);
  let inSection = false;
  const collected: string[] = [];
  for (const line of lines) {
    const headingMatch = /^##\s+(.*)$/.exec(line);
    if (headingMatch !== null) {
      const heading = (headingMatch[1] ?? "").trim().toLowerCase();
      if (inSection) break;
      if (heading === "outstanding") {
        inSection = true;
        continue;
      }
      continue;
    }
    if (inSection) collected.push(line);
  }
  if (!inSection) return null;
  const body = collected.join("\n").trim();
  return body.length === 0 ? null : body;
}
