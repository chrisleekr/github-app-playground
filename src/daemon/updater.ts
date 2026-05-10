import { logger } from "../logger";

// TODO: Wire pullAndRestart() into handleUpdateRequired() in daemon/main.ts
// for the "pull" update strategy. Currently only "exit" (drain + shutdown) is
// implemented; the "pull" and "notify" strategies are defined in config but
// have no caller. See R-016 in specs for the full strategy matrix.

/**
 * Pull-and-restart update strategy (R-016).
 * Runs git pull, bun install, bun run build, then exits with code 75
 * (which signals the wrapper script to restart immediately).
 *
 * On failure, logs the error and does NOT exit: the daemon continues
 * running on the current version (rollback safety).
 */
export async function pullAndRestart(): Promise<void> {
  // Resolve repo root from this module's location (not process.cwd which may differ)
  const path = await import("node:path");
  const repoRoot = path.resolve(path.dirname(import.meta.dir), "..");

  const steps = [
    { cmd: ["git", "pull", "--ff-only"], label: "git pull" },
    { cmd: ["bun", "install", "--frozen-lockfile"], label: "bun install" },
    { cmd: ["bun", "run", "build"], label: "bun build" },
  ];

  for (const step of steps) {
    logger.info({ step: step.label }, "Running update step");
    const proc = Bun.spawn(step.cmd, {
      stdout: "ignore",
      stderr: "pipe",
      cwd: repoRoot,
    });
    // eslint-disable-next-line no-await-in-loop
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await new Response(proc.stderr).text();
      logger.error(
        { step: step.label, exitCode, stderr: stderr.slice(0, 500) },
        "Update step failed, staying on current version (rollback safety)",
      );
      return; // Abort update, daemon continues running
    }
  }

  logger.info("Update complete, exiting with code 75 for restart");
  process.exit(75);
}
