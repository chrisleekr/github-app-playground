import type { ChangedFileData, CommentData, FetchedData, ReviewCommentData } from "../types";
import { sanitizeContent } from "../utils/sanitize";

/**
 * Format PR/issue metadata as a context block.
 *
 * All attacker-controllable fields (title, author login, branch names) are
 * routed through `sanitizeContent` so injected zero-width chars, hidden
 * HTML attributes, and known-format secrets cannot reach the agent prompt
 * verbatim. Branch names are particularly load-bearing because they are
 * also interpolated into git instruction text (`origin/${baseBranch}`)
 * elsewhere in the prompt.
 */
export function formatContext(data: FetchedData): string {
  const sanitizedTitle = sanitizeContent(data.title);
  const sanitizedAuthor = sanitizeContent(data.author);

  if (data.headBranch !== undefined) {
    const sanitizedHeadBranch = sanitizeContent(data.headBranch);
    const sanitizedBaseBranch =
      data.baseBranch !== undefined ? sanitizeContent(data.baseBranch) : "";
    return `PR Title: ${sanitizedTitle}
PR Author: ${sanitizedAuthor}
PR Branch: ${sanitizedHeadBranch} -> ${sanitizedBaseBranch}
PR State: ${data.state}
Changed Files: ${data.changedFiles.length} files`;
  }

  return `Issue Title: ${sanitizedTitle}
Issue Author: ${sanitizedAuthor}
Issue State: ${data.state}`;
}

/**
 * Format the PR/issue body, sanitizing content.
 */
export function formatBody(body: string): string {
  return sanitizeContent(body);
}

/**
 * Format comments as a readable list.
 * Ported from claude-code-action's formatComments()
 */
export function formatComments(comments: CommentData[]): string {
  if (comments.length === 0) return "No comments";

  return comments
    .map((c) => {
      const body = sanitizeContent(c.body);
      return `[${c.author} at ${c.createdAt}]: ${body}`;
    })
    .join("\n\n");
}

/**
 * Format review comments with file path and line info.
 * Ported from claude-code-action's formatReviewComments()
 */
export function formatReviewComments(reviewComments: ReviewCommentData[]): string {
  if (reviewComments.length === 0) return "No review comments";

  return reviewComments
    .map((c) => {
      const body = sanitizeContent(c.body);
      // Path is attacker-controllable (PR diff metadata) and was previously
      // bare-interpolated into the prompt header. Sanitize for parity with
      // the body to deny zero-width / HTML-attr injection vectors.
      const path = sanitizeContent(c.path);
      return `[Comment on ${path}:${c.line ?? "?"}]: ${body}`;
    })
    .join("\n\n");
}

/**
 * Format changed files as a list with stats.
 * Ported from claude-code-action's formatChangedFiles()
 */
export function formatChangedFiles(files: ChangedFileData[]): string {
  if (files.length === 0) return "No files changed";

  return files
    .map((f) => {
      // Filename is attacker-controllable PR diff metadata (verbatim from
      // GitHub GraphQL `files.nodes.path`) and lands inside the spotlit
      // `<untrusted_changed_files>` tag. Sanitize for parity with the
      // review-comment path above to strip zero-width / bidi-override /
      // control characters, hidden HTML attributes, and known-format
      // secrets that could disguise tag-text breakouts. Plain-ASCII
      // counterfeit tags are not addressed here (Phase 1 caveat).
      const filename = sanitizeContent(f.filename);
      return `- ${filename} (${f.status}) +${f.additions}/-${f.deletions}`;
    })
    .join("\n");
}

/**
 * Build all formatted sections from fetched data.
 * Returns the complete formatted output ready for the prompt builder.
 */
export function formatAllSections(
  data: FetchedData,
  isPR: boolean,
): {
  context: string;
  body: string;
  comments: string;
  reviewComments: string;
  changedFiles: string;
} {
  return {
    context: formatContext(data),
    body: data.body ? formatBody(data.body) : "No description provided",
    comments: formatComments(data.comments),
    reviewComments: isPR ? formatReviewComments(data.reviewComments) : "",
    changedFiles: isPR ? formatChangedFiles(data.changedFiles) : "",
  };
}
