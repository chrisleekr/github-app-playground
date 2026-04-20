import { RedisClient } from "bun";

import { config } from "../config";
import { logger } from "../logger";

/**
 * Valkey (Redis-compatible) client singleton for daemon orchestration.
 * Uses Bun's built-in RedisClient with auto-reconnect.
 *
 * Only initialized when VALKEY_URL is configured (non-inline modes).
 * Tracks connection state via onconnect/onclose callbacks (FM-7).
 */

let client: RedisClient | null = null;
let valkeyConnected = false;
let connectStartedAt: number | null = null;

/**
 * Get or create the Valkey client singleton.
 * Returns null when VALKEY_URL is not configured.
 */
export function getValkeyClient(): RedisClient | null {
  if (client !== null) return client;
  if (config.valkeyUrl === undefined) return null;

  connectStartedAt = Date.now();
  logger.info({ valkeyUrl: redactValkeyUrl(config.valkeyUrl) }, "Valkey client created");
  client = new RedisClient(config.valkeyUrl);

  client.onconnect = (): void => {
    valkeyConnected = true;
    const elapsedMs = connectStartedAt === null ? null : Date.now() - connectStartedAt;
    logger.info({ elapsedMs }, "Valkey connected");
  };

  client.onclose = (): void => {
    const wasConnected = valkeyConnected;
    valkeyConnected = false;
    logger.warn({ wasConnected }, "Valkey connection closed");
  };

  return client;
}

/**
 * Strip credentials from a Valkey URL so it's safe to log.
 */
function redactValkeyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password !== "") u.password = "***";
    if (u.username !== "") u.username = "***";
    return u.toString();
  } catch {
    return "<unparseable>";
  }
}

/**
 * Block until the Valkey client is connected (FM-7 startup race fix).
 *
 * Bun's RedisClient connects asynchronously: the `onconnect` callback fires on a
 * later tick. Without awaiting, `isReady` flips true before `valkeyConnected`,
 * so /readyz returns 503 until onconnect fires. This races against K8s probes.
 *
 * Wraps `client.connect()` with a timeout so an unreachable Valkey causes the
 * pod to crash-loop (visible failure) rather than silently sit not-ready.
 */
export async function connectValkey(timeoutMs = 15_000): Promise<void> {
  const c = getValkeyClient();
  if (c === null) {
    logger.info("Valkey not configured, skipping connect");
    return;
  }
  if (valkeyConnected) {
    logger.debug("Valkey already connected, skipping connect");
    return;
  }

  const startedAt = Date.now();
  logger.info({ timeoutMs }, "Awaiting Valkey connection");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Valkey connect timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([c.connect(), timeout]);
    logger.info({ elapsedMs: Date.now() - startedAt }, "Valkey connect awaited");
  } catch (err) {
    logger.error(
      { err, elapsedMs: Date.now() - startedAt },
      "Valkey connect failed during startup",
    );
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Get the Valkey client, throwing if not configured.
 * Use in code paths that require Valkey access (non-inline modes).
 */
export function requireValkeyClient(): RedisClient {
  const c = getValkeyClient();
  if (c === null) {
    throw new Error("VALKEY_URL is not configured but Valkey access was requested");
  }
  return c;
}

/**
 * Check if Valkey is currently connected and healthy (FM-7).
 * Used by /readyz and dispatch guards to reject requests when Valkey is down.
 */
export function isValkeyHealthy(): boolean {
  return valkeyConnected;
}

/**
 * Close the Valkey client. Called during graceful shutdown.
 */
export function closeValkey(): void {
  const current = client;
  if (current !== null) {
    client = null;
    valkeyConnected = false;
    current.close();
    logger.info("Valkey client closed");
  }
}
