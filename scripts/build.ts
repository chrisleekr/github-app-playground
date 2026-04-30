export {};

const isProduction = process.env["NODE_ENV"] === "production";

// Build 1: Main app entry point — outputs dist/app.js
const result = await Bun.build({
  entrypoints: ["./src/app.ts"],
  outdir: "./dist",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "app.js",
});

if (!result.success) {
  console.error("Build failed (app):");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 2: MCP stdio servers — outputs dist/mcp/servers/comment.js and inline-comment.js
// sanitize.ts is inlined into each bundle (splitting: false) since each
// server runs as an independent child process with no shared runtime.
const mcpResult = await Bun.build({
  entrypoints: [
    "./src/mcp/servers/comment.ts",
    "./src/mcp/servers/inline-comment.ts",
    "./src/mcp/servers/resolve-review-thread.ts",
  ],
  outdir: "./dist/mcp/servers",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
});

if (!mcpResult.success) {
  console.error("Build failed (mcp servers):");
  for (const log of mcpResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Build 3: Daemon worker entry point — outputs dist/daemon/main.js
// Invoked by the chart's daemon Deployment via `bun run dist/daemon/main.js`.
// Self-contained bundle (splitting: false) since the daemon runs as its own process.
const daemonResult = await Bun.build({
  entrypoints: ["./src/daemon/main.ts"],
  outdir: "./dist/daemon",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "main.js",
});

if (!daemonResult.success) {
  console.error("Build failed (daemon):");
  for (const log of daemonResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build completed successfully");
