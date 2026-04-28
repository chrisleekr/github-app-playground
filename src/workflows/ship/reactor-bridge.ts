/**
 * Fire-and-forget bridge from webhook event handlers (synchronous, returns
 * void) to the async ship reactor (`fanOut`). Pulls the DB + Valkey
 * singletons and the bot App login at call time so per-event handlers do
 * not need to re-import them.
 *
 * Errors are swallowed to logger.warn — the reactor is a best-effort
 * early-wake; durable state still advances on the next cron tickle.
 */

import { config } from "../../config";
import { getDb } from "../../db";
import { logger } from "../../logger";
import { getValkeyClient } from "../../orchestrator/valkey";
import { fanOut, type ReactorEvent } from "./webhook-reactor";

export function fireReactor(event: ReactorEvent): void {
  const sql = getDb();
  if (sql === null) {
    // No DB configured (e.g. local dev without DATABASE_URL): skip the
    // early-wake. The cron tickle is the durable backstop, but knowing
    // the wake was skipped helps triage "why didn't the bot react to
    // my push" reports.
    logger.debug(
      { event_type: event.type, event: "ship.reactor.bridge_skipped_no_db" },
      "ship reactor early-wake skipped — DATABASE_URL not configured",
    );
    return;
  }
  void (async (): Promise<void> => {
    try {
      await fanOut(event, {
        sql,
        valkey: getValkeyClient(),
        botAppLogin: config.botAppLogin,
      });
    } catch (err) {
      logger.warn(
        { err, event_type: event.type, event: "ship.reactor.bridge_error" },
        "ship reactor fanOut failed (best-effort early-wake; cron will retry)",
      );
    }
  })();
}
