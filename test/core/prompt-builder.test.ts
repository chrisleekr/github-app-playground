/**
 * Tests for src/core/prompt-builder.ts.
 *
 * Covers buildPrompt() and resolveAllowedTools() with various PR/issue contexts.
 * No module mocks — these are pure functions that read from the config singleton
 * (populated by test/preload.ts).
 */

import { describe, expect, it } from "bun:test";

import {
  buildEnvironmentHeader,
  buildPrompt,
  resolveAllowedTools,
} from "../../src/core/prompt-builder";
import type { DaemonCapabilities } from "../../src/shared/daemon-types";
import type { FetchedData } from "../../src/types";
import { makeBotContext, makeFetchedData } from "../factories";

const makeIssueData = (overrides?: Partial<FetchedData>): FetchedData =>
  makeFetchedData({
    title: "Bug report",
    body: "Something is broken",
    author: "reporter",
    ...overrides,
  });

const makePrData = (overrides?: Partial<FetchedData>): FetchedData =>
  makeFetchedData({
    title: "Add feature X",
    body: "PR body",
    author: "dev",
    changedFiles: [{ filename: "src/a.ts", status: "modified", additions: 5, deletions: 2 }],
    headBranch: "feat/x",
    baseBranch: "main",
    headSha: "abc123",
    diff: "",
    ...overrides,
  });

// ─── buildPrompt ────────────────────────────────────────────────────────────

describe("buildPrompt", () => {
  it("generates issue prompt with correct metadata tags", () => {
    const ctx = makeBotContext({ isPR: false, entityNumber: 7 });
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
    const ctx = makeBotContext({ isPR: true, entityNumber: 11 });
    const data = makePrData();
    const result = buildPrompt(ctx, data, 555);

    expect(result).toContain("<is_pr>true</is_pr>");
    expect(result).toContain("<pr_number>11</pr_number>");
    expect(result).toContain("<untrusted_review_comments>");
    expect(result).toContain("<untrusted_changed_files>");
    expect(result).toContain("PR Title: Add feature X");
  });

  it("includes diff instructions for PR with baseBranch", () => {
    const ctx = makeBotContext({ isPR: true });
    const data = makePrData({ baseBranch: "develop" });
    const result = buildPrompt(ctx, data, 1);

    expect(result).toContain("origin/develop");
    expect(result).toContain("git diff origin/develop...HEAD");
  });

  it("omits diff instructions when baseBranch is undefined", () => {
    const ctx = makeBotContext({ isPR: true });
    const data = makePrData({ baseBranch: undefined });
    const result = buildPrompt(ctx, data, 1);

    // Still a PR prompt, but no per-branch diff instructions
    expect(result).not.toContain("git diff origin/");
  });

  it("includes commit instructions with Co-authored-by trailer for PRs", () => {
    const ctx = makeBotContext({ isPR: true, triggerUsername: "alice" });
    const result = buildPrompt(ctx, makePrData(), 1);

    expect(result).toContain("Co-authored-by: alice <alice@users.noreply.github.com>");
  });

  it("omits PR-specific commit instructions for issues", () => {
    const ctx = makeBotContext({ isPR: false });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    // The PR-specific section header should NOT appear for issues
    expect(result).not.toContain("Co-authored-by:");
    // Issue prompts use the generic git instructions at the bottom of the prompt,
    // but not the PR-specific "Use git commands via the Bash tool to commit and push"
    expect(result).not.toContain("Use git commands via the Bash tool to commit and push");
  });

  it("uses REVIEW_COMMENT event type for pull_request_review_comment events", () => {
    const ctx = makeBotContext({
      isPR: true,
      eventName: "pull_request_review_comment",
    });
    const result = buildPrompt(ctx, makePrData(), 1);

    expect(result).toContain("<event_type>REVIEW_COMMENT</event_type>");
    expect(result).toContain("PR review comment with");
  });

  it("sanitizes trigger body to prevent prompt injection", () => {
    const maliciousToken = `ghp_${"A".repeat(36)}`;
    const ctx = makeBotContext({ triggerBody: `@chrisleekr-bot help ${maliciousToken}` });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).not.toContain(maliciousToken);
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("includes trigger_username metadata", () => {
    const ctx = makeBotContext({ triggerUsername: "bob" });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).toContain("<untrusted_trigger_username>bob</untrusted_trigger_username>");
  });

  it("includes the security_directive treating tagged content as data not instructions", () => {
    const ctx = makeBotContext();
    const result = buildPrompt(ctx, makeIssueData(), 1);
    expect(result).toContain("<security_directive>");
    expect(result).toContain("UNTRUSTED user-supplied data");
    expect(result).toContain("</security_directive>");
  });

  it("rejects a triggerUsername containing a newline rather than silently stripping it (git trailer forging)", () => {
    const ctx = makeBotContext({ triggerUsername: "alice\ninjected: trailer" });
    expect(() => buildPrompt(ctx, makeIssueData(), 1)).toThrow(/illegal whitespace\/newline/);
  });
});

// ─── resolveAllowedTools ────────────────────────────────────────────────────

describe("resolveAllowedTools", () => {
  it("includes core file system tools", () => {
    const tools = resolveAllowedTools(makeBotContext());

    expect(tools).toContain("Edit");
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
  });

  it("includes tracking comment MCP tool", () => {
    const tools = resolveAllowedTools(makeBotContext());

    expect(tools).toContain("mcp__github_comment__update_claude_comment");
  });

  it("includes git Bash commands", () => {
    const tools = resolveAllowedTools(makeBotContext());

    expect(tools).toContain("Bash(git add:*)");
    expect(tools).toContain("Bash(git commit:*)");
    expect(tools).toContain("Bash(git push:*)");
    expect(tools).toContain("Bash(git status:*)");
    expect(tools).toContain("Bash(git diff:*)");
    expect(tools).toContain("Bash(git log:*)");
    expect(tools).toContain("Bash(git rm:*)");
  });

  it("adds inline comment tool for PRs", () => {
    const tools = resolveAllowedTools(makeBotContext({ isPR: true }));

    expect(tools).toContain("mcp__github_inline_comment__create_inline_comment");
  });

  it("omits inline comment tool for issues", () => {
    const tools = resolveAllowedTools(makeBotContext({ isPR: false }));

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
      const tools = resolveAllowedTools(makeBotContext());
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
      const tools = resolveAllowedTools(makeBotContext());
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
      const tools = resolveAllowedTools(makeBotContext());
      expect(tools).not.toContain("mcp__context7__resolve-library-id");
      expect(tools).not.toContain("mcp__context7__query-docs");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).context7ApiKey = original;
    }
  });

  it("includes daemon capability CLI tools when daemonCapabilities is provided", () => {
    const caps: DaemonCapabilities = {
      platform: "linux",
      shells: [{ name: "bash", path: "/bin/bash", version: "5.2", functional: true }],
      packageManagers: [
        { name: "npm", path: "/usr/bin/npm", version: "10.0", functional: true },
        { name: "yarn", path: "/usr/bin/yarn", version: "1.22", functional: false },
      ],
      cliTools: [
        { name: "bun", path: "/usr/bin/bun", version: "1.3.8", functional: true },
        { name: "deno", path: "/usr/bin/deno", version: "2.0", functional: false },
      ],
      containerRuntime: {
        name: "docker",
        path: "/usr/bin/docker",
        version: "27.0",
        daemonRunning: true,
        composeAvailable: true,
      },
      authContexts: ["github"],
      resources: { cpuCount: 4, memoryTotalMb: 8192, memoryFreeMb: 4096, diskFreeMb: 50000 },
      network: { hostname: "worker-1" },
      cachedRepos: [],
      ephemeral: false,
      maxUptimeMs: null,
    };

    const tools = resolveAllowedTools(makeBotContext(), caps);

    // Functional CLI tools and package managers get Bash(name:*) entries
    expect(tools).toContain("Bash(bun:*)");
    expect(tools).toContain("Bash(npm:*)");
    // Non-functional tools are excluded
    expect(tools).not.toContain("Bash(deno:*)");
    expect(tools).not.toContain("Bash(yarn:*)");
    // Container runtime with daemonRunning=true gets included
    expect(tools).toContain("Bash(docker:*)");
    // Daemon capabilities MCP tool
    expect(tools).toContain("mcp__daemon_capabilities__query_daemon_capabilities");
    // Repo memory MCP tools
    expect(tools).toContain("mcp__repo_memory__save_repo_memory");
    expect(tools).toContain("mcp__repo_memory__delete_repo_memory");
    expect(tools).toContain("mcp__repo_memory__get_repo_memory");
  });

  it("excludes container runtime when daemonRunning is false", () => {
    const caps: DaemonCapabilities = {
      platform: "darwin",
      shells: [],
      packageManagers: [],
      cliTools: [],
      containerRuntime: {
        name: "docker",
        path: "/usr/bin/docker",
        version: "27.0",
        daemonRunning: false,
        composeAvailable: false,
      },
      authContexts: [],
      resources: { cpuCount: 2, memoryTotalMb: 4096, memoryFreeMb: 2048, diskFreeMb: 20000 },
      network: { hostname: "worker-2" },
      cachedRepos: [],
      ephemeral: false,
      maxUptimeMs: null,
    };

    const tools = resolveAllowedTools(makeBotContext(), caps);

    expect(tools).not.toContain("Bash(docker:*)");
    // Daemon MCP tools are still included when daemon capabilities are present
    expect(tools).toContain("mcp__daemon_capabilities__query_daemon_capabilities");
  });

  it("excludes daemon tools when daemonCapabilities is undefined", () => {
    const tools = resolveAllowedTools(makeBotContext(), undefined);

    expect(tools).not.toContain("mcp__daemon_capabilities__query_daemon_capabilities");
    expect(tools).not.toContain("mcp__repo_memory__save_repo_memory");
  });
});

// ─── buildPrompt — repo_memory section ───────────────────────────────────────

describe("buildPrompt — repo_memory", () => {
  it("includes repo_memory section when repoMemory is non-empty", () => {
    const ctx = makeBotContext({
      repoMemory: [
        { id: "m1", category: "architecture", content: "Uses Bun runtime", pinned: false },
        { id: "m2", category: "convention", content: "No default exports", pinned: true },
      ],
    });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).toContain("<repo_memory>");
    expect(result).toContain("[id:m1] [architecture] Uses Bun runtime");
    expect(result).toContain("[id:m2] [convention] [pinned] No default exports");
    expect(result).toContain("</repo_memory>");
    expect(result).toContain("delete_repo_memory");
  });

  it("omits repo_memory section when repoMemory is undefined", () => {
    const ctx = makeBotContext({ repoMemory: undefined });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    // The string "<repo_memory>" appears in instructions text ("Check <repo_memory>..."),
    // so we check for the opening tag followed by the section content marker instead.
    expect(result).not.toContain("The following learnings have been accumulated");
  });

  it("omits repo_memory section when repoMemory is an empty array", () => {
    const ctx = makeBotContext({ repoMemory: [] });
    const result = buildPrompt(ctx, makeIssueData(), 1);

    expect(result).not.toContain("The following learnings have been accumulated");
  });
});

// ─── buildPrompt — trackingCommentId conditional ─────────────────────────────

describe("buildPrompt — trackingCommentId", () => {
  it("omits claude_comment_id and comment_tool_info when trackingCommentId is undefined", () => {
    const ctx = makeBotContext();
    const result = buildPrompt(ctx, makeIssueData(), undefined);

    expect(result).not.toContain("<claude_comment_id>");
    expect(result).not.toContain("<comment_tool_info>");
    expect(result).not.toContain("mcp__github_comment__update_claude_comment tool");
  });

  it("includes claude_comment_id and comment_tool_info when trackingCommentId is provided", () => {
    const ctx = makeBotContext();
    const result = buildPrompt(ctx, makeIssueData(), 123);

    expect(result).toContain("<claude_comment_id>123</claude_comment_id>");
    expect(result).toContain("<comment_tool_info>");
    expect(result).toContain("mcp__github_comment__update_claude_comment");
  });
});

// ─── buildEnvironmentHeader ──────────────────────────────────────────────────

describe("buildEnvironmentHeader", () => {
  it("returns empty string when daemonCapabilities is undefined", () => {
    const result = buildEnvironmentHeader(undefined);
    expect(result).toBe("");
  });

  it("builds a formatted environment header with all capability sections", () => {
    const caps: DaemonCapabilities = {
      platform: "linux",
      shells: [
        { name: "bash", path: "/bin/bash", version: "5.2", functional: true },
        { name: "zsh", path: "/usr/bin/zsh", version: "5.9", functional: false },
      ],
      packageManagers: [{ name: "npm", path: "/usr/bin/npm", version: "10.0", functional: true }],
      cliTools: [
        { name: "bun", path: "/usr/bin/bun", version: "1.3.8", functional: true },
        { name: "deno", path: "/usr/bin/deno", version: "2.0", functional: true },
      ],
      containerRuntime: {
        name: "docker",
        path: "/usr/bin/docker",
        version: "27.0",
        daemonRunning: true,
        composeAvailable: true,
      },
      authContexts: ["github"],
      resources: { cpuCount: 8, memoryTotalMb: 16384, memoryFreeMb: 8000, diskFreeMb: 100000 },
      network: { hostname: "worker-1" },
      cachedRepos: [],
      ephemeral: false,
      maxUptimeMs: null,
    };

    const result = buildEnvironmentHeader(caps);

    expect(result).toContain("<daemon_environment>");
    expect(result).toContain("</daemon_environment>");
    expect(result).toContain("Platform: linux");
    // Only functional shells
    expect(result).toContain("Shells: bash");
    expect(result).not.toContain("Shells: bash, zsh");
    // Package managers with version
    expect(result).toContain("Package managers: npm@10.0");
    // CLI tools with version
    expect(result).toContain("bun@1.3.8");
    expect(result).toContain("deno@2.0");
    // Container runtime info
    expect(result).toContain("docker@27.0 (daemon: running, compose available)");
    // Resources
    expect(result).toContain("8 CPUs");
    expect(result).toContain("8000MB free memory");
    expect(result).toContain("100000MB free disk");
  });

  it("shows 'none' for empty capability sections", () => {
    const caps: DaemonCapabilities = {
      platform: "darwin",
      shells: [],
      packageManagers: [],
      cliTools: [],
      containerRuntime: null,
      authContexts: [],
      resources: { cpuCount: 2, memoryTotalMb: 4096, memoryFreeMb: 2048, diskFreeMb: 20000 },
      network: { hostname: "worker-2" },
      cachedRepos: [],
      ephemeral: false,
      maxUptimeMs: null,
    };

    const result = buildEnvironmentHeader(caps);

    expect(result).toContain("Shells: none");
    expect(result).toContain("Package managers: none");
    expect(result).toContain("CLI tools: none");
    expect(result).toContain("Container runtime: none");
  });

  it("shows container runtime with stopped daemon", () => {
    const caps: DaemonCapabilities = {
      platform: "linux",
      shells: [],
      packageManagers: [],
      cliTools: [],
      containerRuntime: {
        name: "podman",
        path: "/usr/bin/podman",
        version: "5.0",
        daemonRunning: false,
        composeAvailable: false,
      },
      authContexts: [],
      resources: { cpuCount: 1, memoryTotalMb: 2048, memoryFreeMb: 1024, diskFreeMb: 10000 },
      network: { hostname: "worker-3" },
      cachedRepos: [],
      ephemeral: false,
      maxUptimeMs: null,
    };

    const result = buildEnvironmentHeader(caps);

    expect(result).toContain("podman@5.0 (daemon: stopped)");
    expect(result).not.toContain("compose available");
  });
});
