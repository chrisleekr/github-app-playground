import { z } from "zod";

import type { BotContext } from "../types";

// ---------------------------------------------------------------------------
// Zod schemas (validated at boundary, types inferred below)
// ---------------------------------------------------------------------------

export const discoveredToolSchema = z.object({
  name: z.string(),
  path: z.string(),
  version: z.string(),
  functional: z.boolean(),
});

export const containerRuntimeSchema = z.object({
  name: z.enum(["docker", "podman"]),
  path: z.string(),
  version: z.string(),
  daemonRunning: z.boolean(),
  composeAvailable: z.boolean(),
});

export const daemonResourcesSchema = z.object({
  cpuCount: z.number().positive(),
  memoryTotalMb: z.number().positive(),
  memoryFreeMb: z.number().nonnegative(),
  diskFreeMb: z.number().nonnegative(),
});

export const networkInfoSchema = z.object({
  hostname: z.string(),
  latencyMs: z.number().nonnegative().optional(),
});

// Subset of containerRuntimeSchema baked into the static manifest at image
// build time. `daemonRunning` is probed per-pod and merged in at runtime.
export const staticContainerRuntimeSchema = z.object({
  name: z.enum(["docker", "podman"]),
  path: z.string(),
  version: z.string(),
  composeAvailable: z.boolean(),
});

// Subset of daemonCapabilitiesSchema baked into the static manifest. Excludes
// runtime-varying fields (resources, network, cachedRepos, ephemeral, auth,
// maxUptimeMs, containerRuntime.daemonRunning). Used to validate the baked
// JSON so shape drift fails fast and falls back to a full probe.
export const staticDaemonCapabilitiesSchema = z.object({
  platform: z.enum(["linux", "darwin", "win32"]),
  shells: z.array(discoveredToolSchema),
  packageManagers: z.array(discoveredToolSchema),
  cliTools: z.array(discoveredToolSchema),
  containerRuntime: staticContainerRuntimeSchema.nullable(),
});

export const daemonCapabilitiesSchema = z.object({
  platform: z.enum(["linux", "darwin", "win32"]),
  shells: z.array(discoveredToolSchema),
  packageManagers: z.array(discoveredToolSchema),
  cliTools: z.array(discoveredToolSchema),
  containerRuntime: containerRuntimeSchema.nullable(),
  authContexts: z.array(z.string()),
  resources: daemonResourcesSchema,
  network: networkInfoSchema,
  cachedRepos: z.array(z.string()),
  ephemeral: z.boolean(),
  maxUptimeMs: z.number().positive().nullable(),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type DiscoveredTool = z.infer<typeof discoveredToolSchema>;
export type ContainerRuntime = z.infer<typeof containerRuntimeSchema>;
export type DaemonResources = z.infer<typeof daemonResourcesSchema>;
export type NetworkInfo = z.infer<typeof networkInfoSchema>;
export type DaemonCapabilities = z.infer<typeof daemonCapabilitiesSchema>;
export type StaticDaemonCapabilities = z.infer<typeof staticDaemonCapabilitiesSchema>;
export type StaticContainerRuntime = z.infer<typeof staticContainerRuntimeSchema>;

// ---------------------------------------------------------------------------
// Orchestrator-side daemon info
// ---------------------------------------------------------------------------

export interface DaemonInfo {
  id: string;
  hostname: string;
  platform: string;
  osVersion: string;
  capabilities: DaemonCapabilities;
  /**
   * Daemon lifecycle status.
   * - "active" / "inactive": persisted to Postgres `daemons.status` column.
   * - "draining" / "updating": transient in-memory states tracked via
   *   `drainingDaemons: Set<string>` in the orchestrator process.
   */
  status: "active" | "inactive" | "draining" | "updating";
  protocolVersion: string;
  appVersion: string;
  activeJobs: number;
  lastSeenAt: number;
  firstSeenAt: number;
}

// ---------------------------------------------------------------------------
// In-memory orchestrator state types
// ---------------------------------------------------------------------------

export interface PendingOffer {
  offerId: string;
  deliveryId: string;
  daemonId: string;
  timer: Timer;
  offeredAt: number;
  retryCount: number;
  // Original job metadata preserved for re-queue on rejection/timeout
  repoOwner: string;
  repoName: string;
  entityNumber: number;
  isPR: boolean;
  eventName: string;
  triggerUsername: string;
  labels: string[];
  triggerBodyPreview: string;
}

export interface HeartbeatState {
  intervalTimer: Timer;
  pongTimer: Timer | null;
  awaitingPong: boolean;
  missedPongs: number;
}

// ---------------------------------------------------------------------------
// Daemon-side active job tracking (FM-9)
// ---------------------------------------------------------------------------

export interface ActiveJob {
  offerId: string;
  deliveryId: string;
  workDir: string;
  agentPid: number | null;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// SerializableBotContext
// ---------------------------------------------------------------------------

/**
 * BotContext fields that can be JSON-serialized for WebSocket transmission.
 * Excludes `octokit` (class instance) and `log` (pino logger with streams).
 * Daemon reconstructs these locally from the installation token and delivery ID.
 */
export type SerializableBotContext = Omit<BotContext, "octokit" | "log">;
