import { config } from "../config";

/**
 * Escape special regex characters in a string.
 * Ported from claude-code-action's src/github/validation/trigger.ts
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Module-level constant: built once at startup since config.triggerPhrase is immutable.
 * Avoids allocating a new RegExp object on every webhook event.
 */
// triggerPhrase is a Zod-validated config string; escapeRegExp neutralises all special chars.
// eslint-disable-next-line security/detect-non-literal-regexp
const TRIGGER_REGEX = new RegExp(`(^|\\s)${escapeRegExp(config.triggerPhrase)}([\\s.,!?;:]|$)`);

/**
 * Check if a comment body contains the trigger phrase (@chrisleekr-bot).
 * Uses word boundary matching to avoid false positives.
 *
 * Ported from claude-code-action's checkContainsTrigger()
 */
export function containsTrigger(body: string): boolean {
  return TRIGGER_REGEX.test(body);
}
