import { describe, expect, it } from "bun:test";

import {
  formatAllSections,
  formatBody,
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

  it("strips U+202E (RTL override) from filename", () => {
    const files: ChangedFileData[] = [
      { filename: "evil\u202E.ts", status: "modified", additions: 1, deletions: 0 },
    ];
    const result = formatChangedFiles(files);
    expect(result).not.toContain("\u202E");
    expect(result).toContain("evil.ts");
  });

  it("strips U+200B (zero-width space) from filename", () => {
    const files: ChangedFileData[] = [
      { filename: "evil\u200B.ts", status: "modified", additions: 1, deletions: 0 },
    ];
    const result = formatChangedFiles(files);
    expect(result).not.toContain("\u200B");
    expect(result).toContain("evil.ts");
  });

  it("redacts a ghp_ token embedded in filename", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const files: ChangedFileData[] = [
      { filename: `${token}.ts`, status: "modified", additions: 1, deletions: 0 },
    ];
    const result = formatChangedFiles(files);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });
});

describe("formatBody", () => {
  it("sanitizes body content", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const result = formatBody(`Body with ${token}`);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });

  it("returns sanitized content unchanged when safe", () => {
    expect(formatBody("Hello world")).toBe("Hello world");
  });

  it("handles empty strings", () => {
    expect(formatBody("")).toBe("");
  });
});

describe("formatAllSections", () => {
  const baseData: FetchedData = {
    title: "Test",
    body: "Body content",
    state: "OPEN",
    author: "user",
    comments: [{ author: "alice", body: "Comment", createdAt: "2025-01-01T00:00:00Z" }],
    reviewComments: [
      {
        author: "bob",
        body: "Review",
        path: "a.ts",
        line: 1,
        createdAt: "2025-01-01T00:00:00Z",
      },
    ],
    changedFiles: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
  };

  it("formats all sections for a PR", () => {
    const data: FetchedData = {
      ...baseData,
      headBranch: "feat/x",
      baseBranch: "main",
    };
    const result = formatAllSections(data, true);
    expect(result.context).toContain("PR Title: Test");
    expect(result.body).toBe("Body content");
    expect(result.comments).toContain("alice");
    expect(result.reviewComments).toContain("Review");
    expect(result.changedFiles).toContain("a.ts");
  });

  it("omits review comments and changed files for issues", () => {
    const result = formatAllSections(baseData, false);
    expect(result.context).toContain("Issue Title: Test");
    expect(result.reviewComments).toBe("");
    expect(result.changedFiles).toBe("");
  });

  it("handles missing body with fallback text", () => {
    const data: FetchedData = { ...baseData, body: "" };
    const result = formatAllSections(data, false);
    expect(result.body).toBe("No description provided");
  });

  it("handles empty body in PR context with fallback text", () => {
    // body type is string but empty-string path exercises the `?` fallback branch.
    // isPR=true here distinguishes this test from the sibling at line 216 which
    // uses isPR=false; both exercise the same fallback but from different code
    // paths in formatAllSections.
    const data: FetchedData = { ...baseData, body: "" };
    const result = formatAllSections(data, true);
    expect(result.body).toBe("No description provided");
  });
});
