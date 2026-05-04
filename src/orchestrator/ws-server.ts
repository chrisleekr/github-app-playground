import { timingSafeEqual } from "node:crypto";

import type { ServerWebSocket } from "bun";

import { config } from "../config";
import { logger } from "../logger";
import {
  createMessageEnvelope,
  daemonMessageSchema,
  WS_CLOSE_CODES,
  WS_ERROR_CODES,
} from "../shared/ws-messages";
import { handleDaemonMessage, handleWsClose, handleWsOpen } from "./connection-handler";

/**
 * Per-connection data attached to each WebSocket via ws.data.
 * Set during the HTTP upgrade in the fetch handler.
 */
export interface WsConnectionData {
  /** Authenticated after token check in fetch handler. */
  authenticated: boolean;
  /** Remote address for logging. */
  remoteAddr: string;
  /** Daemon ID — set after daemon:register is processed. */
  daemonId: string | undefined;
}

let server: ReturnType<typeof Bun.serve<WsConnectionData>> | null = null;

/**
 * Constant-time bearer-token comparator. JavaScript's `===`/`!==` short-circuits
 * on the first mismatched byte, leaking the matching prefix length through
 * response latency — a known timing-attack surface for bearer-token auth (#76).
 *
 * Always does work proportional to the longest expected token, regardless of
 * whether the header is missing, shorter, longer, or wrong-content. Accepts
 * either the primary or the optional rotation-window previous token; both
 * branches are evaluated unconditionally and the results are combined with a
 * bitwise OR so a caller cannot distinguish "rejected by primary" from
 * "rejected by previous" via timing.
 */
function isAuthHeaderValid(
  authHeader: string | null | undefined,
  primaryToken: string,
  previousToken: string | undefined,
): boolean {
  const expectedPrimary = Buffer.from(`Bearer ${primaryToken}`, "utf8");
  const expectedPrevious =
    previousToken !== undefined && previousToken.length > 0
      ? Buffer.from(`Bearer ${previousToken}`, "utf8")
      : null;

  // Pad every buffer to the same length before calling timingSafeEqual so
  // it never throws on a length mismatch and the wrong-length path does the
  // same amount of work as the equal-length path. The additional explicit
  // length-equality check below ensures a header longer than the expected
  // (which would be truncated when copying into the padded buffer) is still
  // rejected.
  const padLength = Math.max(expectedPrimary.length, expectedPrevious?.length ?? 0);

  const actualRaw = Buffer.from(authHeader ?? "", "utf8");
  const actual = Buffer.alloc(padLength);
  actualRaw.copy(actual, 0, 0, Math.min(actualRaw.length, padLength));

  const primaryPadded = Buffer.alloc(padLength);
  expectedPrimary.copy(primaryPadded);
  const primaryEq = timingSafeEqual(actual, primaryPadded);
  const primaryLenEq = actualRaw.length === expectedPrimary.length;

  let previousEq = false;
  let previousLenEq = false;
  if (expectedPrevious !== null) {
    const previousPadded = Buffer.alloc(padLength);
    expectedPrevious.copy(previousPadded);
    previousEq = timingSafeEqual(actual, previousPadded);
    previousLenEq = actualRaw.length === expectedPrevious.length;
  }

  // Bitwise OR avoids the JS `||` short-circuit so both branches always run.
  const matchPrimary = Number(primaryEq) & Number(primaryLenEq);
  const matchPrevious = Number(previousEq) & Number(previousLenEq);
  return (matchPrimary | matchPrevious) === 1;
}

/**
 * Start the WebSocket server on WS_PORT.
 * Validates DAEMON_AUTH_TOKEN in the fetch (upgrade) handler per R-009.
 * Returns the Bun Server instance for shutdown coordination.
 */
export function startWebSocketServer(): ReturnType<typeof Bun.serve<WsConnectionData>> {
  if (server !== null) return server;

  const authToken = config.daemonAuthToken;
  if (authToken === undefined) {
    throw new Error("DAEMON_AUTH_TOKEN is required for WebSocket server");
  }
  const previousAuthToken = config.daemonAuthTokenPrevious;

  server = Bun.serve<WsConnectionData>({
    port: config.wsPort,

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== "/ws") {
        return new Response("Not Found", { status: 404 });
      }

      // Validate Authorization header against the primary token, plus the
      // optional rotation-window `_PREVIOUS` token. Comparison is constant-time
      // to avoid leaking the secret via response-latency side channels (#76).
      const authHeader = req.headers.get("authorization");
      if (!isAuthHeaderValid(authHeader, authToken, previousAuthToken)) {
        logger.warn(
          { remoteAddr: srv.requestIP(req)?.address },
          "WebSocket auth failed — invalid token",
        );
        return new Response("Unauthorized", { status: 401 });
      }

      const connectionData: WsConnectionData = {
        authenticated: true,
        remoteAddr: srv.requestIP(req)?.address ?? "unknown",
        daemonId: undefined,
      };

      const upgraded = srv.upgrade(req, { data: connectionData });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      // Bun handles the 101 response when upgrade succeeds — no explicit return needed.
      return undefined;
    },

    websocket: {
      // Application-level pings are handled in connection-handler.ts (FM-2).
      // Bun's sendPings keeps TCP alive as a backstop for half-open connections.
      sendPings: true,
      idleTimeout: 120,
      maxPayloadLength: 1024 * 1024, // 1 MB

      open(ws: ServerWebSocket<WsConnectionData>) {
        logger.info({ remoteAddr: ws.data.remoteAddr }, "WebSocket connection opened");
        handleWsOpen(ws);
      },

      message(ws: ServerWebSocket<WsConnectionData>, message: string | Buffer) {
        const raw = typeof message === "string" ? message : message.toString("utf-8");

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendError(ws, crypto.randomUUID(), WS_ERROR_CODES.INVALID_MESSAGE, "Invalid JSON");
          ws.close(WS_CLOSE_CODES.POLICY_VIOLATION.code, WS_CLOSE_CODES.POLICY_VIOLATION.reason);
          return;
        }

        const result = daemonMessageSchema.safeParse(parsed);
        if (!result.success) {
          const correlationId =
            typeof parsed === "object" && parsed !== null && "id" in parsed
              ? String((parsed as { id: unknown }).id)
              : crypto.randomUUID();
          sendError(
            ws,
            correlationId,
            WS_ERROR_CODES.INVALID_MESSAGE,
            `Schema validation failed: ${result.error.message}`,
          );
          return;
        }

        handleDaemonMessage(ws, result.data);
      },

      close(ws: ServerWebSocket<WsConnectionData>, code: number, reason: string) {
        logger.info({ daemonId: ws.data.daemonId, code, reason }, "WebSocket connection closed");
        handleWsClose(ws, code, reason);
      },
    },
  });

  logger.info({ port: config.wsPort }, "WebSocket server started");
  return server;
}

/**
 * Stop the WebSocket server and wait for in-flight drain.
 * Called during graceful shutdown — the caller must await so that daemon
 * disconnect cleanup paths finish before downstream resources (Valkey, DB)
 * are closed.
 *
 * We race `server.stop(true)` against a 2s timeout because Bun's graceful
 * drain can stall when a client fails to ACK the close frame; letting it
 * block indefinitely would deadlock shutdown and hang tests that rely on
 * server re-creation between cases.
 */
const STOP_DRAIN_TIMEOUT_MS = 2000;

export async function stopWebSocketServer(): Promise<void> {
  if (server !== null) {
    const stopping = server;
    server = null;
    await Promise.race([
      stopping.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
    ]);
    logger.info("WebSocket server stopped");
  }
}

/**
 * Send an error message to a daemon WebSocket connection.
 */
export function sendError(
  ws: ServerWebSocket<WsConnectionData>,
  correlationId: string,
  code: string,
  message: string,
): void {
  const envelope = createMessageEnvelope(correlationId);
  ws.sendText(
    JSON.stringify({
      type: "error",
      ...envelope,
      payload: { code, message },
    }),
  );
}
