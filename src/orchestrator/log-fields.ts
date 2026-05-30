/**
 * Canonical pino log-field schemas for the orchestrator's job-offer and daemon
 * heartbeat lifecycles (issue #187).
 *
 * Mirrors `src/core/log-fields.ts` and `src/orchestrator/fleet-snapshot.ts`: a
 * `.strict()` Zod shape pins each structured event so its fields cannot drift,
 * and the co-located test round-trips a sample line through it. Emitters log
 * plain objects via the root logger at the call site; the schema is the
 * drift-prevention contract, not a runtime validator on the hot path.
 *
 * Naming follows the codebase convention: field keys are camelCase
 * (deliveryId, daemonId, offerId), matching the app-wide pino correlation
 * fields; snake_case is reserved for the numeric-metric idiom, so
 * `offer_latency_ms` parallels `delta_ms`. `event` values are dot.lowercase.
 *
 * `offer_latency_ms` is the offer→accept (or offer→reject / offer→timeout)
 * wall-clock measured against `PendingOffer.offeredAt`, in integer ms.
 */
import { z } from "zod";

export const DISPATCHER_LOG_EVENTS = {
  offer_sent: "dispatcher.offer.sent",
  offer_accepted: "dispatcher.offer.accepted",
  offer_rejected: "dispatcher.offer.rejected",
  offer_timed_out: "dispatcher.offer.timed_out",
  no_eligible_daemon: "dispatcher.no_eligible_daemon",
} as const;

export const DAEMON_HEARTBEAT_LOG_EVENTS = {
  pong_missed: "daemon.heartbeat.pong_missed",
  timeout: "daemon.heartbeat.timeout",
  ttl_refresh_failed: "daemon.heartbeat.ttl_refresh_failed",
} as const;

/**
 * Shared envelope for the four `dispatcher.offer.*` events. `.strict()` so an
 * emitter that adds an unpinned field, or mistypes `offer_latency_ms`, trips
 * the test. `offer_latency_ms` is absent on `offer_sent` (latency is not yet
 * known); `reason` is present only on `offer_rejected`.
 */
export const DispatcherOfferLogSchema = z
  .object({
    event: z.enum([
      DISPATCHER_LOG_EVENTS.offer_sent,
      DISPATCHER_LOG_EVENTS.offer_accepted,
      DISPATCHER_LOG_EVENTS.offer_rejected,
      DISPATCHER_LOG_EVENTS.offer_timed_out,
    ]),
    deliveryId: z.string().min(1),
    daemonId: z.string().min(1),
    offerId: z.string().min(1),
    offer_latency_ms: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
    kind: z.string().optional(),
  })
  .strict();

export type DispatcherOfferLog = z.infer<typeof DispatcherOfferLogSchema>;

/**
 * `dispatcher.no_eligible_daemon` has a distinct shape: no offer was sent, so
 * there is no daemon/offer id, but `fleetSize` + `requiredTools` let an
 * operator tell a capability-match miss from sheer capacity exhaustion.
 */
export const DispatcherNoEligibleDaemonLogSchema = z
  .object({
    event: z.literal(DISPATCHER_LOG_EVENTS.no_eligible_daemon),
    deliveryId: z.string().min(1),
    kind: z.string().optional(),
    fleetSize: z.number().int().nonnegative(),
    requiredTools: z.array(z.string()),
  })
  .strict();

export type DispatcherNoEligibleDaemonLog = z.infer<typeof DispatcherNoEligibleDaemonLogSchema>;

/**
 * Daemon heartbeat lifecycle as seen by the orchestrator. `missedPongs` is the
 * running count of pings sent while a prior pong was still outstanding; present
 * only on `pong_missed`.
 */
export const DaemonHeartbeatLogSchema = z
  .object({
    event: z.enum([
      DAEMON_HEARTBEAT_LOG_EVENTS.pong_missed,
      DAEMON_HEARTBEAT_LOG_EVENTS.timeout,
      DAEMON_HEARTBEAT_LOG_EVENTS.ttl_refresh_failed,
    ]),
    daemonId: z.string().min(1),
    missedPongs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DaemonHeartbeatLog = z.infer<typeof DaemonHeartbeatLogSchema>;
