/**
 * Tests for src/core/prompt-builder.ts.
 *
 * Covers buildPrompt() and resolveAllowedTools() with various PR/issue contexts.
 * No module mocks — these are pure functions that read from the config singleton
 * (populated by test/preload.ts).
 */

import { describe, expect, it } from "bun:test";

import { buildPrompt, resolveAllowedTools } from "../../src/core/prompt-builder";
import type { BotContext, FetchedData } from "../../src/types";

// ─── Factories ──────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<BotContext>): BotContext {
  const silentLog = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child(): BotContext["log"] {
      return this as unknown as BotContext["log"];
    },
  } as unknown as BotContext["log"];

  return {
    owner: "myorg",
    repo: "myrepo",
    entityNumber: 42,
    isPR: false,
    eventName: "issue_comment" as const,
    triggerUsername: "tester",
    triggerTimestamp: "2025-01-01T00:00:00Z",
    triggerBody: "@chrisleekr-bot please help",
    commentId: 1,
    deliveryId: "test-delivery",
    defaultBranch: "main",
    octokit: {} as BotContext["octokit"],
    log: silentLog,
    ...overrides,
  };
}

function makeIssueData(overrides?: Partial<FetchedData>): FetchedData {
  return {
    title: "Bug report",
    body: "Something is broken",
    state: "OPEN",
    author: "reporter",
    comments: [],
    reviewComments: [],
    changedFiles: [],
    ...overrides,
  };
}

function makePrData(overrides?: Partial<FetchedData>): FetchedData {
  return {
    title: "Add feature X",
    body: "PR body",
    state: "OPEN",
    author: "dev",
    comments: [],
    reviewComments: [],
    changedFiles: [{ filename: "src/a.ts", status: "modified", additions: 5, deletions: 2 }],
    headBranch: "feat/x",
    baseBranch: "main",
    headSha: "abc123",
    diff: "",
    ...overrides,
  };
}

// ─── buildPrompt ────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("generates issue prompt with correct metadata tags", () => {
    const ctx = makeCtx({ isPR: false, entityNumber: 7 });
    const data = makeIssueData({ title: "Bug" });
    const result = buildPrompt(ctx, data, 999);

    expect(result).toContain("<is_pr>false</is_pr>");
    expect(result).toContain("<event_type>GENERAL_COMMENT</event_type>");
    expect(result).toContain("<issue_number>7</issue_number>");
    expect(result).toContain("<repository>myorg/myrepo</repository>");
    expect(result).toContain("<claude_comment_id>999</claude_comment_id>");
    expect(result).toContain("Issue Title: Bug");
    expect(result).not.toContain("<pr_number>");
  });

  it("generates PR prompt with pr_number and PR-specific instructions", () => {
    const ctx = makeCtx({ isPR: true, entityNumber: 11 });
    const data = makePrData();
    const result = buildPrompt(ctx, data, 555);

    expect(result).toContain("<is_pr>true</is_pr>");
    expect(result).toContain("<pr_number>11</pr_number>");
    expect(result).toContain("<review_comments>");
    expect(result).toContain("<changed_files>");
    expect(result).toContain("PR Title: Add feature X");
  });

  it("includes diff instructions for PR with baseBranch", () => {
    const ctx = makeCtx({ isPR: true });
    const data = makePrData({ baseBranch: "develop" });
    const result = buildPrompt(ctx, data, 1);

    expect(result).toContain("origin/develop");
    expect(result).toContain("git diff origin/develop...HEAD");
  });

  it("omits diff instructions when baseBranch is undefined", () => {
    const ctx = makeCtx({ isPR: true });
    const data = makePrData({ baseBranch: undefined });
    const result = buildPrompt(ctx, data, 1);

    // Still a PR prompt, but no per-branch diff instructions
    expect(result).not.toContain("git diff origin/");
  });

  it("includes commit instructions with Co-authored-by trailer for PRs", () => {
    const ctx = makeCtx({ isPR: true, triggerUsername: "alice" });
    const result = buildPrompt(ctx, makePrData(), 1);

    expect(result).toContain("Co-authored-by: alice <alice@users.noreply.github.com>");
  });

  it("omits PR-specific commit instructions for issues", () => {
    const ctx = makeCtx({ isPR: false });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    // The PR-specific section header should NOT appear for issues
    expect(result).not.toContain("Co-authored-by:");
    // Issue prompts use the generic git instructions at the bottom of the prompt,
    // but not the PR-specific "Use git commands via the Bash tool to commit and push"
    expect(result).not.toContain("Use git commands via the Bash tool to commit and push");
  });

  it("uses REVIEW_COMMENT event type for pull_request_review_comment events", () => {
    const ctx = makeCtx({
      isPR: true,
      eventName: "pull_request_review_comment",
    });
    const result = buildPrompt(ctx, makePrData(), 1);

    expect(result).toContain("<event_type>REVIEW_COMMENT</event_type>");
    expect(result).toContain("PR review comment with");
  });

  it("sanitizes trigger body to prevent prompt injection", () => {
    const maliciousToken = `ghp_${"A".repeat(36)}`;
    const ctx = makeCtx({ triggerBody: `@chrisleekr-bot help ${maliciousToken}` });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).not.toContain(maliciousToken);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("includes trigger_username metadata", () => {
    const ctx = makeCtx({ triggerUsername: "bob" });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).toContain("<trigger_username>bob</trigger_username>");
  });
});

// ─── resolveAllowedTools ────────────────────────────────────────────────────

describe("resolveAllowedTools", () => {
  it("includes core file system tools", () => {
    const tools = resolveAllowedTools(makeCtx());

    expect(tools).toContain("Edit");
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
  });

  it("includes tracking comment MCP tool", () => {
    const tools = resolveAllowedTools(makeCtx());

    expect(tools).toContain("mcp__github_comment__update_claude_comment");
  });

  it("includes git Bash commands", () => {
    const tools = resolveAllowedTools(makeCtx());

    expect(tools).toContain("Bash(git add:*)");
    expect(tools).toContain("Bash(git commit:*)");
    expect(tools).toContain("Bash(git push:*)");
    expect(tools).toContain("Bash(git status:*)");
    expect(tools).toContain("Bash(git diff:*)");
    expect(tools).toContain("Bash(git log:*)");
    expect(tools).toContain("Bash(git rm:*)");
  });

  it("adds inline comment tool for PRs", () => {
    const tools = resolveAllowedTools(makeCtx({ isPR: true }));

    expect(tools).toContain("mcp__github_inline_comment__create_inline_comment");
  });

  it("omits inline comment tool for issues", () => {
    const tools = resolveAllowedTools(makeCtx({ isPR: false }));

    expect(tools).not.toContain("mcp__github_inline_comment__create_inline_comment");
  });

  it("includes both Context7 tools when config.context7ApiKey is a non-empty string", async () => {
    // Mutate the config singleton for this test only. try/finally ensures
    // the original value is restored even if an assertion fails, so subsequent
    // tests see a clean state.
    const { config } = await import("../../src/config");
    const original = config.context7ApiKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).context7ApiKey = "ctx7-test-key";

    try {
      const tools = resolveAllowedTools(makeCtx());
      expect(tools).toContain("mcp__context7__resolve-library-id");
      expect(tools).toContain("mcp__context7__query-docs");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).context7ApiKey = original;
    }
  });

  it("excludes Context7 tools when config.context7ApiKey is undefined", async () => {
    const { config } = await import("../../src/config");
    const original = config.context7ApiKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).context7ApiKey = undefined;

    try {
      const tools = resolveAllowedTools(makeCtx());
      expect(tools).not.toContain("mcp__context7__resolve-library-id");
      expect(tools).not.toContain("mcp__context7__query-docs");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).context7ApiKey = original;
    }
  });

  it("excludes Context7 tools when config.context7ApiKey is an empty string", async () => {
    const { config } = await import("../../src/config");
    const original = config.context7ApiKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any).context7ApiKey = "";

    try {
      const tools = resolveAllowedTools(makeCtx());
      expect(tools).not.toContain("mcp__context7__resolve-library-id");
      expect(tools).not.toContain("mcp__context7__query-docs");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).context7ApiKey = original;
    }
  });
});
