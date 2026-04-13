import { logger } from "../logger";
import type { DaemonCapabilities } from "../shared/daemon-types";
import {
  createMessageEnvelope,
  PROTOCOL_VERSION,
  type ServerMessage,
  serverMessageSchema,
} from "../shared/ws-messages";

// Read version from package.json at module load
const APP_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Bun supports require for JSON; dynamic import would be async
    const pkg = require("../../package.json") as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
})();

/**
 * Decorrelated jitter backoff for reconnection (R-002).
 * Base: 1s, Cap: 30s. Formula: min(cap, random_between(base, sleep * 3))
 */
function nextBackoff(previousMs: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, Math.random() * Math.max(baseMs, previousMs * 3));
}

export interface WsClientOptions {
  orchestratorUrl: string;
  authToken: string;
  daemonId: string;
  capabilities: DaemonCapabilities;
  onMessage: (msg: ServerMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

/**
 * WebSocket client with auto-reconnection using decorrelated jitter backoff.
 * Connects to the orchestrator, sends daemon:register on open.
 */
export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnecting = false;
  private closed = false;
  private backoffMs = 1000;
  private reconnectTimer: Timer | null = null;

  private readonly BASE_BACKOFF_MS = 1000;
  private readonly CAP_BACKOFF_MS = 30_000;

  constructor(private readonly opts: WsClientOptions) {}

  /** Connect to the orchestrator. */
  connect(): void {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.opts.orchestratorUrl, {
        headers: {
          Authorization: `Bearer ${this.opts.authToken}`,
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to create WebSocket connection");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      logger.info({ orchestratorUrl: this.opts.orchestratorUrl }, "Connected to orchestrator");
      this.backoffMs = this.BASE_BACKOFF_MS;
      this.reconnecting = false;
      this.sendRegister();
      this.opts.onConnected();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn("Received invalid JSON from orchestrator");
        return;
      }

      const result = serverMessageSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn({ error: result.error.message }, "Received invalid message from orchestrator");
        return;
      }

      this.opts.onMessage(result.data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      logger.info({ code: event.code, reason: event.reason }, "Disconnected from orchestrator");
      this.opts.onDisconnected();

      if (!this.closed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event: Event) => {
      logger.error({ event }, "WebSocket error");
    };
  }

  /** Send a message to the orchestrator. */
  send(message: unknown): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      logger.warn("Cannot send — WebSocket not connected");
    }
  }

  /** Send the daemon:register message on connection open. */
  private sendRegister(): void {
    const { hostname } = this.opts.capabilities.network;

    this.send({
      type: "daemon:register",
      ...createMessageEnvelope(),
      payload: {
        daemonId: this.opts.daemonId,
        hostname,
        platform: this.opts.capabilities.platform,
        osVersion: process.version,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: APP_VERSION,
        capabilities: this.opts.capabilities,
      },
    });
  }

  /** Schedule a reconnection with decorrelated jitter backoff. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;

    this.backoffMs = nextBackoff(this.backoffMs, this.BASE_BACKOFF_MS, this.CAP_BACKOFF_MS);
    logger.info({ backoffMs: Math.round(this.backoffMs) }, "Reconnecting to orchestrator");

    this.reconnectTimer = setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, this.backoffMs);
  }

  /** Gracefully close the connection. No reconnect. */
  close(code = 1000, reason = "graceful shutdown"): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close(code, reason);
      this.ws = null;
    }
  }

  /** Check if the client is connected. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
