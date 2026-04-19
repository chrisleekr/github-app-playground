#!/usr/bin/env bun
/**
 * Bake the static subset of DaemonCapabilities into a JSON file at image build
 * time. Runs inside Dockerfile.daemon's `daemon-tools` stage AFTER all tools
 * are installed. The resulting manifest is loaded at daemon startup by
 * src/daemon/tool-discovery.ts → discoverCapabilities(), skipping ~50 `which`
 * probes per pod restart.
 *
 * Usage: bun run scripts/generate-capabilities-manifest.ts <output-path>
 *
 * Invoked from Dockerfile.daemon as:
 *   bun run scripts/generate-capabilities-manifest.ts /app/daemon-capabilities.static.json
 */

import { writeFileSync } from "node:fs";

import { probeStaticCapabilities } from "../src/daemon/tool-discovery";

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (outputPath === undefined || outputPath === "") {
    console.error("Usage: generate-capabilities-manifest.ts <output-path>");
    process.exit(1);
  }

  const caps = await probeStaticCapabilities();

  const functionalCli = caps.cliTools.filter((t) => t.functional).map((t) => t.name);
  const missingCli = caps.cliTools.filter((t) => !t.functional).map((t) => t.name);

  console.log(`Platform: ${caps.platform}`);
  console.log(
    `Shells functional: ${caps.shells
      .filter((s) => s.functional)
      .map((s) => s.name)
      .join(", ")}`,
  );
  console.log(`CLI tools functional (${functionalCli.length}): ${functionalCli.join(", ")}`);
  if (missingCli.length > 0) {
    console.log(`CLI tools MISSING (${missingCli.length}): ${missingCli.join(", ")}`);
  }
  console.log(`Container runtime: ${caps.containerRuntime?.name ?? "none"}`);

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- build-time script; path is an argv
  writeFileSync(outputPath, JSON.stringify(caps, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
