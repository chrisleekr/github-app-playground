#!/usr/bin/env bun
/**
 * CI guard: Dockerfile.orchestrator and Dockerfile.daemon share a base
 * section (oven/bun pin + Node install + OpenSSL patches + npm + claude-code
 * CLI + deps/development stages). Drift between them bakes security/behaviour
 * skew into the two images. We enclose the shared region in marker comments
 * and assert byte equality here.
 *
 * Markers (must appear exactly once per file):
 *   # --- SHARED-BASE-BEGIN ---
 *   # --- SHARED-BASE-END ---
 *
 * Exit 0 on match, 1 on mismatch with a unified diff on stderr.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BEGIN_MARKER = "# --- SHARED-BASE-BEGIN ---";
const END_MARKER = "# --- SHARED-BASE-END ---";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORCHESTRATOR = join(repoRoot, "Dockerfile.orchestrator");
const DAEMON = join(repoRoot, "Dockerfile.daemon");

function extractSharedBlock(filePath: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- constant paths above
  const contents = readFileSync(filePath, "utf-8");
  const beginIdx = contents.indexOf(BEGIN_MARKER);
  const endIdx = contents.indexOf(END_MARKER);
  if (beginIdx === -1) {
    throw new Error(`${filePath}: missing '${BEGIN_MARKER}' marker`);
  }
  if (endIdx === -1) {
    throw new Error(`${filePath}: missing '${END_MARKER}' marker`);
  }
  if (endIdx <= beginIdx) {
    throw new Error(`${filePath}: '${END_MARKER}' must appear after '${BEGIN_MARKER}'`);
  }
  // Include both marker lines; mismatch on the markers themselves also fails.
  return contents.slice(beginIdx, endIdx + END_MARKER.length);
}

function diff(a: string, b: string, labelA: string, labelB: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  for (let i = 0; i < max; i++) {
    const ax = aLines[i] ?? "";
    const bx = bLines[i] ?? "";
    if (ax !== bx) {
      out.push(`@@ line ${i + 1} @@`);
      if (ax !== "") out.push(`- ${ax}`);
      if (bx !== "") out.push(`+ ${bx}`);
    }
  }
  return out.join("\n");
}

function main(): void {
  const orchBlock = extractSharedBlock(ORCHESTRATOR);
  const daemonBlock = extractSharedBlock(DAEMON);

  if (orchBlock === daemonBlock) {
    console.log(
      "OK: SHARED-BASE blocks match between Dockerfile.orchestrator and Dockerfile.daemon",
    );
    return;
  }

  console.error(
    "ERROR: SHARED-BASE blocks differ between Dockerfile.orchestrator and Dockerfile.daemon.",
  );
  console.error(
    "Both files must keep the block byte-identical so the two images share the exact same base layer behaviour.\n",
  );
  console.error(diff(orchBlock, daemonBlock, "Dockerfile.orchestrator", "Dockerfile.daemon"));
  process.exit(1);
}

main();
