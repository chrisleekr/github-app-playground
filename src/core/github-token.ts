import type { Octokit } from "octokit";

import { config } from "../config";

/**
 * Resolve the GitHub credential the bot should use for API/git operations.
 *
 * - When GITHUB_PERSONAL_ACCESS_TOKEN is set, return the PAT directly so the
 *   bot acts as that user (single-tenant, ALLOWED_OWNERS enforced at startup).
 * - Otherwise mint a fresh installation token via the App-scoped Octokit so
 *   the existing multi-tenant flow is unchanged.
 *
 * Downstream consumers (git credential helper, executor env, MCP server env)
 * are token-agnostic: they accept whichever string this returns.
 *
 * `pat` defaults to the singleton config so production callers stay one-arg;
 * tests inject explicit values to avoid mocking the config module.
 */
export async function resolveGithubToken(
  octokit: Pick<Octokit, "auth">,
  pat?: string,
): Promise<string> {
  // `nonEmptyOptionalString` in src/config.ts strips empty strings, so the
  // singleton field is `string | undefined` at runtime, narrow explicitly
  // because z.preprocess loses that in the inferred Config type.
  const fallback: string | undefined =
    typeof config.githubPersonalAccessToken === "string"
      ? config.githubPersonalAccessToken
      : undefined;
  const resolved = pat ?? fallback;
  if (resolved !== undefined) {
    return resolved;
  }
  const auth = (await octokit.auth({ type: "installation" })) as { token: string };
  return auth.token;
}
