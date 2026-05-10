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
let valkeyShuttingDown = false;
let connectStartedAt: number | null = null;
// Resolvers waiting for the next onconnect to fire. Drained in onconnect.
// Keeps connectValkey()'s readiness signal tied to the actual flag flip,
// not to client.connect()'s promise, Bun does not document ordering between
// connect() resolving and onconnect firing.
const pendingConnectResolvers: (() => void)[] = [];

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
    // Drain any connectValkey() awaiters now that the flag is true.
    while (pendingConnectResolvers.length > 0) {
      const resolve = pendingConnectResolvers.shift();
      resolve?.();
    }
  };

  client.onclose = (): void => {
    const wasConnected = valkeyConnected;
    const intentional = valkeyShuttingDown;
    valkeyConnected = false;
    if (intentional) {
      logger.info({ wasConnected }, "Valkey connection closed (intentional shutdown)");
    } else {
      logger.warn({ wasConnected }, "Valkey connection closed");
    }
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
 * Awaits the `onconnect` callback specifically: NOT `client.connect()`'s
 * promise: because Bun does not document that the callback fires before the
 * promise resolves. Since `valkeyConnected` is only flipped inside `onconnect`,
 * tying our readiness signal to the callback guarantees `isValkeyHealthy()`
 * returns true the instant `connectValkey()` resolves.
 *
 * Times out so an unreachable Valkey crash-loops the pod (visible failure)
 * instead of silently sitting not-ready.
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
  let resolverRef: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Valkey connect timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      resolverRef = (): void => {
        resolve();
      };
      pendingConnectResolvers.push(resolverRef);

      // Kick the connection (idempotent if already connecting). We discard the
      // promise's resolution and rely on onconnect to flip the flag, but we
      // forward connection errors so we don't wait for the timeout on hard fail.
      c.connect().catch((err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    logger.info({ elapsedMs: Date.now() - startedAt }, "Valkey connect awaited");
  } catch (err) {
    if (resolverRef !== undefined) {
      const idx = pendingConnectResolvers.indexOf(resolverRef);
      if (idx >= 0) pendingConnectResolvers.splice(idx, 1);
    }
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
    // Mark intentional so onclose can distinguish shutdown from real disconnect.
    // Don't pre-clear valkeyConnected, let onclose do it so wasConnected
    // reflects the true pre-shutdown state in logs.
    valkeyShuttingDown = true;
    try {
      current.close();
    } finally {
      valkeyShuttingDown = false;
      valkeyConnected = false;
    }
    logger.info("Valkey client closed");
  }
}
