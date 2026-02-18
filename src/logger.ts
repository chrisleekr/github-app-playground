import pino from "pino";

import { config } from "./config";

/**
 * Root logger instance.
 * JSON output in production, pino-pretty in development.
 * Per pino best practices: https://github.com/pinojs/pino
 */
export const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development" ? { transport: { target: "pino-pretty" } } : {}),
});

/**
 * Create a child logger scoped to a specific webhook delivery.
 * Consistent fields across all log lines for a single request.
 */
export function createChildLogger(fields: {
  deliveryId: string;
  owner: string;
  repo: string;
  entityNumber: number;
}): pino.Logger {
  return logger.child(fields);
}

export type Logger = pino.Logger;
