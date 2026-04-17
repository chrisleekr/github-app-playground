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
  entrypoints: ["./src/mcp/servers/comment.ts", "./src/mcp/servers/inline-comment.ts"],
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

// Build 3: Isolated-job pod entrypoint — outputs dist/k8s/job-entrypoint.js
// Referenced by job-spawner.ts as the container command. Bundling into dist
// keeps the production image self-contained (the production stage in
// Dockerfile only copies dist/, not src/).
const jobEntrypointResult = await Bun.build({
  entrypoints: ["./src/k8s/job-entrypoint.ts"],
  outdir: "./dist/k8s",
  target: "bun",
  minify: isProduction,
  sourcemap: isProduction ? "external" : "inline",
  splitting: false,
  naming: "job-entrypoint.js",
});

if (!jobEntrypointResult.success) {
  console.error("Build failed (job-entrypoint):");
  for (const log of jobEntrypointResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build completed successfully");
