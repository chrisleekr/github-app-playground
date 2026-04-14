import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { cpus, freemem, hostname, platform, totalmem } from "node:os";

import { logger } from "../logger";
import type { DaemonCapabilities, DaemonResources, DiscoveredTool } from "../shared/daemon-types";

const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

// Resource snapshot (R-007)

/**
 * Get current system resources (CPU, memory, disk).
 * Called on every heartbeat for fresh data.
 */
export function getCurrentResources(): DaemonResources {
  const cpuCount = cpus().length;
  const memoryTotalMb = Math.round(totalmem() / (1024 * 1024));
  const memoryFreeMb = Math.round(freemem() / (1024 * 1024));

  let diskFreeMb = 0;
  try {
    const stats = statfsSync("/");
    diskFreeMb = Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    // statfs may fail on some platforms
  }

  return { cpuCount, memoryTotalMb, memoryFreeMb, diskFreeMb };
}

// Tool discovery helpers

function discoverTool(name: string, versionFlag = "--version"): DiscoveredTool {
  try {
    // Use execFileSync to avoid shell interpolation (prevents command injection)
    const pathResult = execFileSync("which", [name], { encoding: "utf-8", timeout: 5_000 }).trim();
    let version = "unknown";
    try {
      const raw = execFileSync(name, [versionFlag], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      // Extract first line, strip common prefixes
      const firstLine = raw.split("\n")[0] ?? raw;
      version = firstLine.replace(/^[^0-9]*/, "") || firstLine;
    } catch {
      // Version check failed but binary exists
    }
    return { name, path: pathResult, version, functional: true };
  } catch {
    return { name, path: "", version: "", functional: false };
  }
}

// Ephemeral detection

function detectEphemeral(): boolean {
  // Docker / container detection
  if (existsSync("/.dockerenv")) return true;
  // Kubernetes pod
  if (process.env["KUBERNETES_SERVICE_HOST"] !== undefined) return true;
  return false;
}

// Full capability scan (R-007)

/**
 * Discover daemon capabilities: tools, container runtime, resources, etc.
 * Runs a full scan at startup and every 10th heartbeat.
 */
export async function discoverCapabilities(cloneBaseDir: string): Promise<DaemonCapabilities> {
  const plat = platform();

  const shells = ["bash", "sh", "zsh", "fish"].map((s) => discoverTool(s));
  const packageManagers = ["bun", "node", "npm", "yarn", "pnpm"].map((p) => discoverTool(p));
  const cliTools = ["git", "curl", "jq", "python3", "aws", "make", "gh"].map((t) =>
    discoverTool(t),
  );

  let containerRuntime: DaemonCapabilities["containerRuntime"] = null;
  for (const rt of ["docker", "podman"] as const) {
    const tool = discoverTool(rt);
    if (tool.functional) {
      let daemonRunning = false;
      try {
        execFileSync(rt, ["info"], { timeout: 5_000, stdio: "pipe" });
        daemonRunning = true;
      } catch {
        // daemon not running
      }

      let composeAvailable = false;
      try {
        execFileSync(rt, ["compose", "version"], { timeout: 5_000, stdio: "pipe" });
        composeAvailable = true;
      } catch {
        // compose not available
      }

      containerRuntime = {
        name: rt,
        path: tool.path,
        version: tool.version,
        daemonRunning,
        composeAvailable,
      };
      break; // Use first found
    }
  }

  // Auth contexts — best-effort, non-functional if CLI not logged in
  const authContexts: string[] = [];
  try {
    execFileSync("gh", ["auth", "status"], { timeout: 5_000, stdio: "pipe" });
    authContexts.push("github");
  } catch {
    // Not authenticated
  }

  const cachedRepos: string[] = [];
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(cloneBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        cachedRepos.push(entry.name);
      }
    }
  } catch {
    // Directory may not exist yet
  }

  const resources = getCurrentResources();
  const ephemeral = detectEphemeral();

  logger.debug(
    {
      platform: plat,
      functionalShells: shells.filter((s) => s.functional).map((s) => s.name),
      functionalCli: cliTools.filter((t) => t.functional).map((t) => t.name),
      containerRuntime: containerRuntime?.name ?? "none",
      ephemeral,
    },
    "Capability discovery complete",
  );

  if (!SUPPORTED_PLATFORMS.includes(plat as SupportedPlatform)) {
    throw new Error(
      `Unsupported platform: ${plat}. Expected one of: ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }

  return {
    platform: plat as SupportedPlatform,
    shells,
    packageManagers,
    cliTools,
    containerRuntime,
    authContexts,
    resources,
    network: {
      hostname: hostname(),
    },
    cachedRepos,
    ephemeral,
    maxUptimeMs: ephemeral ? 3_600_000 : null, // 1 hour for ephemeral
  };
}
