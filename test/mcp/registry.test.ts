/**
 * Regression test for the MCP server build/resolve invariants.
 *
 * Two bugs we never want to ship again, both surfaced as
 * `MCP server module not found for "<name>"` from a daemon Pod:
 *
 *   1. A new server file under `src/mcp/servers/` is referenced by
 *      `registry.ts` but missing from `scripts/build.ts` entrypoints,
 *      so it does not exist in the production image.
 *   2. `resolveServerPath` looks under the wrong base directory when
 *      `registry.ts` is bundled into `dist/app.js` or `dist/daemon/main.js`
 *      (see file comment for the full bundle-vs-source layout).
 *
 * The first suite exercises every opt-in path of `resolveMcpServers` with
 * all flags set and asserts every stdio server's resolved path exists.
 * Running from `src/` resolves through the `.ts` candidate, which proves the
 * registry-side wiring is sound but does not by itself prove the production
 * `.js` candidates resolve.
 *
 * The second suite closes that gap by replicating `scripts/build.ts`'s
 * auto-discovery rule against the source tree and asserting every name
 * registered in `registry.ts` is in the discovered set. If a server is
 * registered without being bundled (as `repo-memory` was in `001990d`),
 * this fails at test time rather than at runtime in a daemon Pod.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import type { Logger } from "pino";

import { resolveMcpServers } from "../../src/mcp/registry";
import type { DaemonCapabilities } from "../../src/shared/daemon-types";
import type { BotContext } from "../../src/types";

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => noopLog,
} as unknown as Logger;

function ctx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    owner: "chrisleekr",
    repo: "github-app-playground",
    entityNumber: 1,
    isPR: true,
    eventName: "issue_comment",
    triggerUsername: "chrisleekr",
    triggerTimestamp: "2026-05-10T00:00:00Z",
    triggerBody: "@chrisleekr-bot test",
    commentId: 42,
    deliveryId: "delivery-1",
    defaultBranch: "main",
    labels: [],
    octokit: {} as BotContext["octokit"],
    log: noopLog,
    ...overrides,
  };
}

const fakeDaemonCaps: DaemonCapabilities = {
  daemonId: "test",
  hostname: "test-host",
  os: { platform: "linux", arch: "x64", release: "test" },
  tools: {},
  generatedAt: new Date().toISOString(),
} as unknown as DaemonCapabilities;

describe("resolveMcpServers stdio paths", () => {
  it("every registered stdio server resolves to a file that exists", () => {
    const servers = resolveMcpServers(ctx(), 99, "ghs_token", {
      workDir: "/tmp/test-workdir",
      enableResolveReviewThread: true,
      enableGithubState: true,
      daemonCapabilities: fakeDaemonCaps,
    });

    const stdioPaths = Object.entries(servers)
      .filter(([, def]) => def.type === "stdio")
      .map(([name, def]) => {
        // Stdio defs from registry.ts use args = ["run", serverPath]
        const args = (def as { args?: string[] }).args ?? [];
        return { name, path: args[1] };
      });

    expect(stdioPaths.length).toBeGreaterThan(0);
    for (const { name, path } of stdioPaths) {
      if (path === undefined || path === "") {
        throw new Error(`MCP server "${name}" must resolve to a non-empty path`);
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from registry.ts resolveServerPath
      expect(existsSync(path), `MCP server "${name}" file missing on disk: ${path}`).toBe(true);
    }
  });

  it("registers repo_memory and daemon_capabilities when their inputs are provided", () => {
    const servers = resolveMcpServers(ctx(), 99, "ghs_token", {
      workDir: "/tmp/test-workdir",
      daemonCapabilities: fakeDaemonCaps,
    });

    expect(servers["repo_memory"]).toBeDefined();
    expect(servers["daemon_capabilities"]).toBeDefined();
  });
});

/**
 * Source-level invariant: every server name registry.ts asks `resolveServerPath`
 * for must also be picked up by scripts/build.ts's auto-discovery filter, so it
 * actually exists in the production image. This catches the regression that
 * shipped in `001990d` (repo-memory.ts registered but missing from build
 * entrypoints) without depending on a populated `dist/` (CI runs tests before
 * build). The discovery rule is replicated verbatim from scripts/build.ts.
 */
describe("MCP server registration vs build discovery", () => {
  const registryPath = join(import.meta.dir, "../../src/mcp/registry.ts");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- registryPath is a fixed test fixture path, not user input
  const registrySrc = readFileSync(registryPath, "utf8");
  // Match resolveServerPath("name") or resolveServerPath('name'), tolerating
  // whitespace around the argument. Template-literal calls would defeat the
  // invariant (dynamic name) and are intentionally not matched: the test fails
  // loudly if the source switches to a form this regex does not understand,
  // forcing reconsideration rather than silently passing.
  const callRegex = /resolveServerPath\(\s*(['"])([^'"]+)\1\s*\)/g;
  const registeredNames = Array.from(registrySrc.matchAll(callRegex), (m) => {
    if (m[2] === undefined) throw new Error("regex group 2 missing");
    return m[2];
  });

  const serversDir = join(import.meta.dir, "../../src/mcp/servers");
  const discovered = new Set(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- serversDir is a fixed test fixture path, not user input
    readdirSync(serversDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) =>
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- file name comes from readdirSync of a fixed dir
        readFileSync(join(serversDir, f), "utf8").includes("StdioServerTransport"),
      )
      .map((f) => f.replace(/\.ts$/, "")),
  );

  it("finds at least one resolveServerPath call site (regex sanity)", () => {
    expect(registeredNames.length).toBeGreaterThan(0);
  });

  it.each(registeredNames.map((n) => [n]))("build.ts auto-discovery includes server %s", (name) => {
    expect(
      discovered.has(name),
      `Server "${name}" is registered in registry.ts but scripts/build.ts auto-discovery does not pick up src/mcp/servers/${name}.ts. Either the file is missing, or it does not import StdioServerTransport (the discovery marker).`,
    ).toBe(true);
  });
});
