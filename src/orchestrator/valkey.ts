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

/**
 * Get or create the Valkey client singleton.
 * Returns null when VALKEY_URL is not configured.
 */
export function getValkeyClient(): RedisClient | null {
  if (client !== null) return client;
  if (config.valkeyUrl === undefined) return null;

  client = new RedisClient(config.valkeyUrl);

  client.onconnect = (): void => {
    valkeyConnected = true;
    logger.info("Valkey connected");
  };

  client.onclose = (): void => {
    valkeyConnected = false;
    logger.warn("Valkey connection closed");
  };

  return client;
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
