import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, hostname, platform, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  type DaemonCapabilities,
  daemonCapabilitiesSchema,
  type DaemonResources,
  type DiscoveredTool,
  type StaticContainerRuntime,
  type StaticDaemonCapabilities,
  staticDaemonCapabilitiesSchema,
} from "../shared/daemon-types";

// Minimal logger shape used by this module. We avoid importing `../logger` at
// the top level because it transitively loads `../config`, which runs Zod
// validation at import time and requires runtime secrets. The build-time
// manifest generator (scripts/generate-capabilities-manifest.ts) imports
// `probeStaticCapabilities` from this file and must not pull in app config.
interface ToolDiscoveryLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

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
  "nvm",
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
  ["kubectl", ["version", "--client=true"]],
  ["helm", ["version", "--short"]],
  ["asdf", ["--version"]],
]);

// Resource snapshot (always dynamic)

/** Called on every heartbeat for fresh values. */
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

async function discoverTool(name: string): Promise<DiscoveredTool> {
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
    const { stdout: whichOut } = await execFileAsync("which", [name], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    const pathResult = whichOut.trim();
    let version = "unknown";
    try {
      const args = VERSION_FLAGS.get(name) ?? ["--version"];
      const { stdout: versionOut } = await execFileAsync(name, args, {
        encoding: "utf-8",
        timeout: 5_000,
      });
      const firstLine = versionOut.trim().split("\n")[0] ?? versionOut.trim();
      // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- capture-group match is clearer than exec() here
      const semverMatch = firstLine.match(/v?(\d+\.\d+(?:\.\d+)?(?:[-.+][\w.-]{0,32})?)/);
      version = semverMatch?.[1] ?? firstLine;
    } catch {
      // Version check failed but binary exists
    }
    return { name, path: pathResult, version, functional: true };
  } catch {
    return { name, path: "", version: "", functional: false };
  }
}

async function discoverToolsParallel(names: readonly string[]): Promise<DiscoveredTool[]> {
  return Promise.all(names.map((n) => discoverTool(n)));
}

// Container runtime probe

async function probeContainerRuntimeStatic(): Promise<StaticContainerRuntime | null> {
  // Serial by design: prefer docker; only probe podman if docker is absent.
  // Parallelising would waste a subprocess in the common case.
  for (const rt of ["docker", "podman"] as const) {
    // eslint-disable-next-line no-await-in-loop -- intentional serial probe
    const tool = await discoverTool(rt);
    if (!tool.functional) continue;
    let composeAvailable = false;
    try {
      // eslint-disable-next-line no-await-in-loop -- only runs once (return below)
      await execFileAsync(rt, ["compose", "version"], { timeout: 5_000 });
      composeAvailable = true;
    } catch {
      // compose not available
    }
    return { name: rt, path: tool.path, version: tool.version, composeAvailable };
  }
  return null;
}

async function probeContainerDaemonRunning(name: "docker" | "podman"): Promise<boolean> {
  try {
    await execFileAsync(name, ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// Ephemeral detection

function detectEphemeral(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env["KUBERNETES_SERVICE_HOST"] !== undefined) return true;
  return false;
}

// Auth + repo probes

async function probeAuthContexts(): Promise<string[]> {
  const contexts: string[] = [];
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 5_000 });
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

// Static manifest loader

// Validated against staticDaemonCapabilitiesSchema on load so shape drift
// (schema change without rebuilding the image) triggers a fall-through to
// the full probe rather than a cryptic crash later at merge time.
function loadStaticManifest(logger: ToolDiscoveryLogger): StaticDaemonCapabilities | null {
  try {
    if (!existsSync(STATIC_MANIFEST_PATH)) return null;

    const raw = readFileSync(STATIC_MANIFEST_PATH, "utf-8");
    return staticDaemonCapabilitiesSchema.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      { err, path: STATIC_MANIFEST_PATH },
      "Failed to load or validate static capabilities manifest; falling back to probe",
    );
    return null;
  }
}

// Full probe (slow path — used by manifest generator and dev fallback)

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

  const [shells, packageManagers, cliTools, containerRuntime] = await Promise.all([
    discoverToolsParallel(SHELL_NAMES),
    discoverToolsParallel(PACKAGE_MANAGER_NAMES),
    discoverToolsParallel(CLI_TOOL_NAMES),
    probeContainerRuntimeStatic(),
  ]);

  return {
    platform: plat as SupportedPlatform,
    shells,
    packageManagers,
    cliTools,
    containerRuntime,
  };
}

// Public entry point

/**
 * Discover daemon capabilities. Fast path: load static fields from the baked
 * manifest; merge with dynamic (per-pod) probes. Slow path: run a full probe
 * when the manifest is absent (dev loop, locally built image).
 */
export async function discoverCapabilities(cloneBaseDir: string): Promise<DaemonCapabilities> {
  // Lazy import: see ToolDiscoveryLogger comment above for why this cannot
  // be a top-level import.
  const { logger } = await import("../logger");
  const bakedManifest = loadStaticManifest(logger);
  const staticCaps = bakedManifest ?? (await probeStaticCapabilities());

  const resources = getCurrentResources();
  const [authContexts, cachedRepos] = await Promise.all([
    probeAuthContexts(),
    listCachedRepos(cloneBaseDir),
  ]);
  const ephemeral = detectEphemeral();

  const containerRuntime =
    staticCaps.containerRuntime !== null
      ? {
          ...staticCaps.containerRuntime,
          daemonRunning: await probeContainerDaemonRunning(staticCaps.containerRuntime.name),
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
