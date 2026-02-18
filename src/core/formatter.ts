import type { ChangedFileData, CommentData, FetchedData, ReviewCommentData } from "../types";
import { sanitizeContent } from "../utils/sanitize";

/**
 * Format PR/issue metadata as a context block.
 * Ported from claude-code-action's formatContext()
 */
export function formatContext(data: FetchedData): string {
  const sanitizedTitle = sanitizeContent(data.title);

  if (data.headBranch !== undefined) {
    // PR context
    return `PR Title: ${sanitizedTitle}
PR Author: ${data.author}
PR Branch: ${data.headBranch} -> ${data.baseBranch}
PR State: ${data.state}
Changed Files: ${data.changedFiles.length} files`;
  }

  // Issue context
  return `Issue Title: ${sanitizedTitle}
Issue Author: ${data.author}
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
      return `[Comment on ${c.path}:${c.line ?? "?"}]: ${body}`;
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
    .map((f) => `- ${f.filename} (${f.status}) +${f.additions}/-${f.deletions}`)
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
