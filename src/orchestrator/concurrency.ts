import { config } from "../config";
import { logger } from "../logger";

/**
 * Orchestrator-process concurrency tracking for MAX_CONCURRENT_REQUESTS
 * (FR-008).
 *
 * Single owner: connection-handler.ts.
 *  - `incrementActiveCount()` runs in `handleAccept`, the moment a daemon
 *    claims an offered job (after `removePendingOffer` and before any DB
 *    work that may fail).
 *  - `decrementActiveCount()` runs in `handleResult` and in `handleAccept`'s
 *    error paths so every increment has exactly one matching decrement.
 *
 * Counts in-flight work AT daemons (offered+accepted), not enqueued work.
 * `isAtCapacity()` is read in router.ts to gate webhook admission. Cascade
 * children dispatched from inside the daemon process never touch this
 * counter on the daemon side: their offer/accept on the orchestrator side
 * is the only event that mutates it.
 */

let activeCount = 0;

export function getActiveCount(): number {
  return activeCount;
}

export function incrementActiveCount(): void {
  activeCount++;
}

export function decrementActiveCount(): void {
  if (activeCount > 0) {
    activeCount--;
  } else {
    logger.warn("Attempted to decrement activeCount below zero");
  }
}

export function isAtCapacity(): boolean {
  return activeCount >= config.maxConcurrentRequests;
}
