#!/usr/bin/env bun
/**
 * Post-build smoke test for the MCP server bundle.
 *
 * Catches the failure mode that shipped in `001990d` (daemon Pod throwing
 * `MCP server module not found for "repo-memory"`). Two cooperating bugs:
 *
 *   1. A server registered in `src/mcp/registry.ts` was missing from
 *      `scripts/build.ts` entrypoints, so `dist/mcp/servers/<name>.js`
 *      did not exist.
 *   2. `resolveServerPath()` resolved candidate URLs against
 *      `import.meta.url`, which after `Bun.build` inlines `registry.ts`
 *      into `dist/app.js` or `dist/daemon/main.js` points at the bundle
 *      rather than the source, so the URL math landed in the wrong dir.
 *
 * The source-level invariant test in `test/mcp/registry.test.ts` covers
 * (1) without depending on a populated `dist/`. This script covers (2):
 * it reads `dist/app.js` and `dist/daemon/main.js` as anchor URLs, walks
 * the same candidate list `registry.ts` uses, and asserts every name
 * registered via `resolveServerPath("...")` resolves to an existing
 * `dist/mcp/servers/<name>.js` from BOTH bundle locations. Run it after
 * `bun run build` (CI does this in `ci.yml`).
 *
 * Exit codes: 0 ok, 1 missing bundle, 2 unresolved candidate.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const registrySrc = readFileSync("src/mcp/registry.ts", "utf8");
const registeredNames = Array.from(registrySrc.matchAll(/resolveServerPath\("([^"]+)"\)/g), (m) => {
  if (m[1] === undefined) throw new Error("regex group 1 missing");
  return m[1];
});

if (registeredNames.length === 0) {
  console.error("FAIL: regex found zero resolveServerPath() call sites in registry.ts");
  process.exit(2);
}

// Bundles consume registry.ts. Keep this list aligned with `scripts/build.ts`
// build steps 1 and 3 (app + daemon entrypoints).
const bundlePaths = ["dist/app.js", "dist/daemon/main.js"];

// Mirrors the candidate list in `src/mcp/registry.ts:resolveServerPath`. Drift
// here means the smoke and the runtime resolver disagree, which would silently
// hide the bug class this script exists to catch.
const candidatesFor = (name: string): string[] => [
  `./servers/${name}.js`,
  `./mcp/servers/${name}.js`,
  `../mcp/servers/${name}.js`,
  `./servers/${name}.ts`,
];

let failed = 0;

for (const bundle of bundlePaths) {
  if (!existsSync(bundle)) {
    console.error(`FAIL: ${bundle} does not exist; run \`bun run build\` first.`);
    process.exit(1);
  }
  const baseUrl = pathToFileURL(bundle).href;
  for (const name of registeredNames) {
    const hit = candidatesFor(name)
      .map((c) => fileURLToPath(new URL(c, baseUrl)))
      .find((p) => existsSync(p));
    if (hit === undefined) {
      console.error(`FAIL: ${bundle} cannot resolve MCP server "${name}" via any candidate URL`);
      failed++;
    } else {
      console.log(`ok  ${bundle} -> ${name} -> ${hit}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} unresolved candidate(s).`);
  process.exit(2);
}

console.log(
  `\nSmoke OK: ${registeredNames.length} MCP server name(s) resolve from ${bundlePaths.length} bundle location(s).`,
);
