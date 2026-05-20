import type { AppliedReviewLearning } from "../../utils/review-learnings-filter";

/**
 * Render the `🧠 Learnings used` collapsible footer appended to review /
 * resolve tracking comments. Discloses every learning that informed the run
 * with full provenance (source PR, author, file glob, timestamp).
 *
 * Empty input yields an empty string so the caller can spread the result
 * unconditionally. Newly-saved learnings (from `save_review_learning`) are
 * NOT included here because the persistence happens orchestrator-side after
 * the daemon emits the result; the next review will surface them.
 *
 * The block emits one fenced code section per learning so the layout stays
 * diffable and copy-pasteable, mirroring how operators read CI log blocks.
 */
export function renderReviewLearningsFooter(
  applied: readonly AppliedReviewLearning[] | undefined,
): string {
  if (applied === undefined || applied.length === 0) return "";

  const entries = applied.map((l) => {
    const source = formatSource(l.sourcePr);
    const author = l.sourceAuthor ?? "(unknown)";
    const glob = l.fileGlob ?? "*";
    const rationale = l.rationale ?? "(not recorded)";
    const recorded = formatRecorded(l.createdAt);
    return [
      "```",
      `From:      ${author}`,
      `Source:    ${source}`,
      `Scope:     ${l.scope}`,
      `File glob: ${glob}`,
      `Recorded:  ${recorded}`,
      `Directive: ${l.directive}`,
      `Why:       ${rationale}`,
      "```",
    ].join("\n");
  });

  return `\n\n<details>\n<summary>🧠 Learnings used (${String(applied.length)})</summary>\n\n${entries.join("\n\n")}\n\n</details>`;
}

/**
 * Format a source-PR reference. Split out so the `prefer-nullish-coalescing`
 * rule's preferred shape (`??`) cannot apply: the PR number and the fallback
 * string differ structurally, not just by nullness.
 */
function formatSource(sourcePr: number | null): string {
  if (sourcePr === null) return "(unknown source)";
  return `#${String(sourcePr)}`;
}

/**
 * Format the "Recorded:" timestamp line. ISO strings from the DB are kept
 * compact (YYYY-MM-DD) so the footer stays scannable; full precision lives
 * in the DB row if anyone needs it.
 */
function formatRecorded(createdAt: string | undefined): string {
  if (createdAt === undefined) return "(unknown)";
  // Take the leading YYYY-MM-DD portion of an ISO 8601 timestamp. Defensive
  // slice in case the orchestrator hands back something unexpected.
  const date = createdAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : createdAt;
}
