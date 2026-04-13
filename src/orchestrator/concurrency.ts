import { config } from "../config";
import { logger } from "../logger";

/**
 * Cross-module concurrency tracking for MAX_CONCURRENT_REQUESTS (FR-008).
 *
 * Extracted from router.ts so both inline dispatch (increment/decrement in router)
 * and daemon dispatch (increment in router, decrement on job:result in
 * connection-handler) can share the same counter.
 *
 * Without this, daemon-dispatched jobs would leak activeCount (increment in router
 * but never decrement), eventually exhausting MAX_CONCURRENT_REQUESTS.
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
