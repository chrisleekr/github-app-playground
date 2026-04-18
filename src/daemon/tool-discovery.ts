import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, hostname, platform, totalmem } from "node:os";

import { logger } from "../logger";
import {
  type DaemonCapabilities,
  daemonCapabilitiesSchema,
  type DaemonResources,
  type DiscoveredTool,
} from "../shared/daemon-types";

const SUPPORTED_PLATFORMS = ["linux", "darwin", "win32"] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/**
 * Baked at image build time by scripts/generate-capabilities-manifest.ts.
 * Contains the subset of DaemonCapabilities that does not vary per pod:
 * platform, shells, packageManagers, cliTools, containerRuntime.{name,path,
 * version,composeAvailable}. Runtime-varying fields (resources, authContexts,
 * hostname, cachedRepos, ephemeral, containerRuntime.daemonRunning) are
 * always probed fresh.
 */
const STATIC_MANIFEST_PATH = "/app/daemon-capabilities.static.json";

const SHELL_NAMES = ["bash", "sh", "zsh", "fish"];
const PACKAGE_MANAGER_NAMES = ["bun", "node", "npm", "yarn", "pnpm"];

/**
 * Tools probed on the daemon. Mirrors the baked inventory in Dockerfile.daemon
 * plus common extras. Runtime `sudo apt-get install` adds tools NOT in this
 * list; Claude discovers those via Bash `which <tool>` at task time.
 */
const CLI_TOOL_NAMES = [
  // Core
  "git",
  "curl",
  "wget",
  "jq",
  "yq",
  "unzip",
  "zip",
  // Python ecosystem
  "python3",
  "pip",
  "pipx",
  "poetry",
  "uv",
  // Build
  "make",
  // Cloud CLIs
  "aws",
  "gh",
  "gcloud",
  "az",
  // Kubernetes
  "kubectl",
  "helm",
  "kustomize",
  "k9s",
  "stern",
  "argocd",
  "flux",
  // IaC
  "terraform",
  "tflint",
  "ansible",
  // Linters
  "shellcheck",
  "hadolint",
  // Version managers
  "asdf",
  // Data clients
  "mysql",
  "psql",
  "redis-cli",
  "sqlite3",
  "mongosh",
  // Editors + navigation
  "vim",
  "nano",
  "less",
  "tree",
  "rg",
  "fd",
  "bat",
  "fzf",
  "direnv",
  "tmux",
  "ssh",
  "rsync",
  // Docs + media
  "pandoc",
  "convert",
  "mkcert",
  // Languages
  "go",
  "cargo",
  // TUI helpers + HTTP
  "gum",
  "glow",
  "http",
  // System
  "apt-get",
];

/**
 * Override for tools whose `--version` doesn't exist, takes too long, or emits
 * noise. Anything not listed uses the default `--version`. Map (not Record) to
 * sidestep eslint-plugin-security's object-injection rule on dynamic-key reads.
 */
const VERSION_FLAGS = new Map<string, string[]>([
  ["kubectl", ["version", "--client=true", "--output=yaml"]],
  ["helm", ["version", "--short"]],
  ["asdf", ["--version"]],
]);

// ---------------------------------------------------------------------------
// Resource snapshot (always dynamic)
// ---------------------------------------------------------------------------

/**
 * Get current system resources (CPU, memory, disk). Called on every heartbeat.
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

// ---------------------------------------------------------------------------
// Tool discovery helpers
// ---------------------------------------------------------------------------

function discoverTool(name: string): DiscoveredTool {
  // nvm is a shell function sourced from /usr/local/nvm/nvm.sh, not a binary.
  // `which nvm` always fails in a non-interactive shell, so fall back to a
  // filesystem check when the script is installed at the baked path.
  if (name === "nvm") {
    const nvmScript = "/usr/local/nvm/nvm.sh";
    if (existsSync(nvmScript)) {
      return { name, path: nvmScript, version: "sourced", functional: true };
    }
    return { name, path: "", version: "", functional: false };
  }

  try {
    const pathResult = execFileSync("which", [name], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    let version = "unknown";
    try {
      const args = VERSION_FLAGS.get(name) ?? ["--version"];
      const raw = execFileSync(name, args, {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
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

async function discoverToolsParallel(names: readonly string[]): Promise<DiscoveredTool[]> {
  return Promise.all(names.map((n) => Promise.resolve(discoverTool(n))));
}

// ---------------------------------------------------------------------------
// Container runtime probe
// ---------------------------------------------------------------------------

interface StaticContainerRuntime {
  name: "docker" | "podman";
  path: string;
  version: string;
  composeAvailable: boolean;
}

function probeContainerRuntimeStatic(): StaticContainerRuntime | null {
  for (const rt of ["docker", "podman"] as const) {
    const tool = discoverTool(rt);
    if (!tool.functional) continue;
    let composeAvailable = false;
    try {
      execFileSync(rt, ["compose", "version"], { timeout: 5_000, stdio: "pipe" });
      composeAvailable = true;
    } catch {
      // compose not available
    }
    return { name: rt, path: tool.path, version: tool.version, composeAvailable };
  }
  return null;
}

function probeContainerDaemonRunning(name: "docker" | "podman"): boolean {
  try {
    execFileSync(name, ["info"], { timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ephemeral detection
// ---------------------------------------------------------------------------

function detectEphemeral(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env["KUBERNETES_SERVICE_HOST"] !== undefined) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Auth + repo probes
// ---------------------------------------------------------------------------

function probeAuthContexts(): string[] {
  const contexts: string[] = [];
  try {
    execFileSync("gh", ["auth", "status"], { timeout: 5_000, stdio: "pipe" });
    contexts.push("github");
  } catch {
    // Not authenticated
  }
  return contexts;
}

async function listCachedRepos(cloneBaseDir: string): Promise<string[]> {
  const cachedRepos: string[] = [];
  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(cloneBaseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) cachedRepos.push(entry.name);
    }
  } catch {
    // Directory may not exist yet
  }
  return cachedRepos;
}

// ---------------------------------------------------------------------------
// Static manifest loader
// ---------------------------------------------------------------------------

/**
 * Subset of DaemonCapabilities baked at build time. Excludes fields that vary
 * per pod (resources, network, authContexts, cachedRepos, ephemeral,
 * maxUptimeMs, containerRuntime.daemonRunning).
 */
export interface StaticDaemonCapabilities {
  platform: SupportedPlatform;
  shells: DiscoveredTool[];
  packageManagers: DiscoveredTool[];
  cliTools: DiscoveredTool[];
  containerRuntime: StaticContainerRuntime | null;
}

function loadStaticManifest(): StaticDaemonCapabilities | null {
  try {
    if (!existsSync(STATIC_MANIFEST_PATH)) return null;

    const raw = readFileSync(STATIC_MANIFEST_PATH, "utf-8");
    return JSON.parse(raw) as StaticDaemonCapabilities;
  } catch (err) {
    logger.warn(
      { err, path: STATIC_MANIFEST_PATH },
      "Failed to load static capabilities manifest; falling back to probe",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full probe (slow path — used by manifest generator and dev fallback)
// ---------------------------------------------------------------------------

/**
 * Probe the host for all static capability fields. Used by
 * scripts/generate-capabilities-manifest.ts at image build time AND as the
 * runtime fallback when the baked manifest is absent (dev loop, non-container).
 */
export async function probeStaticCapabilities(): Promise<StaticDaemonCapabilities> {
  const plat = platform();
  if (!SUPPORTED_PLATFORMS.includes(plat as SupportedPlatform)) {
    throw new Error(
      `Unsupported platform: ${plat}. Expected one of: ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }

  const [shells, packageManagers, cliTools] = await Promise.all([
    discoverToolsParallel(SHELL_NAMES),
    discoverToolsParallel(PACKAGE_MANAGER_NAMES),
    discoverToolsParallel(CLI_TOOL_NAMES),
  ]);

  return {
    platform: plat as SupportedPlatform,
    shells,
    packageManagers,
    cliTools,
    containerRuntime: probeContainerRuntimeStatic(),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Discover daemon capabilities. Fast path: load static fields from the baked
 * manifest; merge with dynamic (per-pod) probes. Slow path: run a full probe
 * when the manifest is absent (dev loop, locally built image).
 */
export async function discoverCapabilities(cloneBaseDir: string): Promise<DaemonCapabilities> {
  const bakedManifest = loadStaticManifest();
  const staticCaps = bakedManifest ?? (await probeStaticCapabilities());

  const resources = getCurrentResources();
  const authContexts = probeAuthContexts();
  const cachedRepos = await listCachedRepos(cloneBaseDir);
  const ephemeral = detectEphemeral();

  const containerRuntime =
    staticCaps.containerRuntime !== null
      ? {
          ...staticCaps.containerRuntime,
          daemonRunning: probeContainerDaemonRunning(staticCaps.containerRuntime.name),
        }
      : null;

  const capabilities: DaemonCapabilities = {
    platform: staticCaps.platform,
    shells: staticCaps.shells,
    packageManagers: staticCaps.packageManagers,
    cliTools: staticCaps.cliTools,
    containerRuntime,
    authContexts,
    resources,
    network: { hostname: hostname() },
    cachedRepos,
    ephemeral,
    maxUptimeMs: ephemeral ? 3_600_000 : null,
  };

  logger.debug(
    {
      platform: capabilities.platform,
      functionalShells: capabilities.shells.filter((s) => s.functional).map((s) => s.name),
      functionalCli: capabilities.cliTools.filter((t) => t.functional).map((t) => t.name),
      containerRuntime: capabilities.containerRuntime?.name ?? "none",
      ephemeral,
      staticManifest: bakedManifest !== null,
    },
    "Capability discovery complete",
  );

  // Validate the merged shape — catches drift between the baked manifest and
  // the schema after a daemon-types.ts change.
  return daemonCapabilitiesSchema.parse(capabilities);
}
