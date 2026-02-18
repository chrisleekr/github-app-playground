import { describe, expect, it } from "bun:test";

import {
  formatChangedFiles,
  formatComments,
  formatContext,
  formatReviewComments,
} from "../../src/core/formatter";
import type { ChangedFileData, CommentData, FetchedData, ReviewCommentData } from "../../src/types";

describe("formatContext", () => {
  it("formats PR context with branch info", () => {
    const data: FetchedData = {
      title: "Add feature",
      body: "",
      state: "OPEN",
      author: "user1",
      comments: [],
      reviewComments: [],
      changedFiles: [{ filename: "a.ts", status: "modified", additions: 10, deletions: 2 }],
      headBranch: "feat/branch",
      baseBranch: "main",
    };
    const result = formatContext(data);
    expect(result).toContain("PR Title: Add feature");
    expect(result).toContain("PR Author: user1");
    expect(result).toContain("PR Branch: feat/branch -> main");
    expect(result).toContain("PR State: OPEN");
    expect(result).toContain("Changed Files: 1 files");
  });

  it("formats issue context without branch info", () => {
    const data: FetchedData = {
      title: "Bug report",
      body: "",
      state: "OPEN",
      author: "user2",
      comments: [],
      reviewComments: [],
      changedFiles: [],
    };
    const result = formatContext(data);
    expect(result).toContain("Issue Title: Bug report");
    expect(result).toContain("Issue Author: user2");
    expect(result).toContain("Issue State: OPEN");
    expect(result).not.toContain("Branch");
  });

  it("sanitizes title content", () => {
    const data: FetchedData = {
      title: "Title with <!-- hidden --> comment",
      body: "",
      state: "OPEN",
      author: "user",
      comments: [],
      reviewComments: [],
      changedFiles: [],
    };
    const result = formatContext(data);
    expect(result).not.toContain("hidden");
    expect(result).toContain("Title with");
  });
});

describe("formatComments", () => {
  it("formats comments with author and timestamp", () => {
    const comments: CommentData[] = [
      { author: "alice", body: "Great work!", createdAt: "2025-01-01T00:00:00Z" },
    ];
    const result = formatComments(comments);
    expect(result).toContain("[alice at 2025-01-01T00:00:00Z]: Great work!");
  });

  it("returns 'No comments' for empty array", () => {
    expect(formatComments([])).toBe("No comments");
  });

  it("formats multiple comments separated by double newlines", () => {
    const comments: CommentData[] = [
      { author: "alice", body: "First", createdAt: "2025-01-01T00:00:00Z" },
      { author: "bob", body: "Second", createdAt: "2025-01-02T00:00:00Z" },
    ];
    const result = formatComments(comments);
    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result.split("\n\n")).toHaveLength(2);
  });

  it("sanitizes comment bodies", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const comments: CommentData[] = [
      { author: "user", body: `token: ${token}`, createdAt: "2025-01-01T00:00:00Z" },
    ];
    const result = formatComments(comments);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });
});

describe("formatReviewComments", () => {
  it("formats review comments with file path and line", () => {
    const comments: ReviewCommentData[] = [
      {
        author: "reviewer",
        body: "Fix this",
        path: "src/app.ts",
        line: 42,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    const result = formatReviewComments(comments);
    expect(result).toContain("[Comment on src/app.ts:42]: Fix this");
  });

  it("handles missing line number", () => {
    const comments: ReviewCommentData[] = [
      {
        author: "reviewer",
        body: "General",
        path: "src/app.ts",
        createdAt: "2025-01-01T00:00:00Z",
      },
    ];
    const result = formatReviewComments(comments);
    expect(result).toContain("[Comment on src/app.ts:?]: General");
  });

  it("returns 'No review comments' for empty array", () => {
    expect(formatReviewComments([])).toBe("No review comments");
  });
});

describe("formatChangedFiles", () => {
  it("formats files with stats", () => {
    const files: ChangedFileData[] = [
      { filename: "src/app.ts", status: "modified", additions: 10, deletions: 5 },
    ];
    const result = formatChangedFiles(files);
    expect(result).toBe("- src/app.ts (modified) +10/-5");
  });

  it("formats multiple files", () => {
    const files: ChangedFileData[] = [
      { filename: "a.ts", status: "added", additions: 20, deletions: 0 },
      { filename: "b.ts", status: "removed", additions: 0, deletions: 15 },
    ];
    const result = formatChangedFiles(files);
    expect(result).toContain("- a.ts (added) +20/-0");
    expect(result).toContain("- b.ts (removed) +0/-15");
  });

  it("returns 'No files changed' for empty array", () => {
    expect(formatChangedFiles([])).toBe("No files changed");
  });
});
