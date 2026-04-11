import { config } from "../config";
import type { Logger } from "../logger";

/**
 * Result of an authorization check.
 * Discriminated union so callers must branch on `allowed` before reading `reason`.
 */
export type AuthorizeResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Check whether a repository owner is permitted to trigger the bot.
 *
 * Tenancy boundary enforced at the `repository.owner` level (case-insensitive,
 * matching GitHub's own identity semantics: `ChrisLeeKR` === `chrisleekr`).
 *
 * REQUIRED when using CLAUDE_CODE_OAUTH_TOKEN. The Claude Agent SDK Note
 * prohibits serving other users' repos from a personal subscription quota:
 * https://code.claude.com/docs/en/agent-sdk/overview
 *
 * Empty/unset allowlist means "no restriction" — preserves open behavior for
 * multi-tenant deployments that use ANTHROPIC_API_KEY or AWS Bedrock (both are
 * in-policy with their respective billing models).
 */
export function isOwnerAllowed(owner: string, log: Logger): AuthorizeResult {
  if (config.allowedOwners === undefined) {
    return { allowed: true };
  }
  const normalized = owner.toLowerCase();
  const match = config.allowedOwners.some((o) => o.toLowerCase() === normalized);
  if (match) {
    return { allowed: true };
  }
  log.warn(
    { owner, allowedOwners: config.allowedOwners },
    "rejected: owner not in ALLOWED_OWNERS allowlist",
  );
  return {
    allowed: false,
    reason: `Owner "${owner}" is not in the configured allowlist.`,
  };
}
