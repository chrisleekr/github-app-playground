/**
 * Observed installation-token mint helper (issue #236).
 *
 * Six call sites mint App installation tokens (handleAccept, handleScopedAccept,
 * postOrphanNotification, shipTickleResume, proposalPoller, schedulerRunAction).
 * None emitted a structured event, so operators had no `cache_hit` signal, no
 * per-call latency, and no per-installation correlation. This helper wraps
 * `app.getInstallationOctokit(installationId)` + `resolveGithubToken(octokit)`
 * with `Date.now()` bracketing and a cache-hit probe, emitting one
 * `github.app.token.mint.succeeded` (info) or `github.app.token.mint.failed`
 * (warn) line per call.
 *
 * `cache_hit` is exact, not a latency heuristic: octokit's `@octokit/auth-app`
 * serves cached tokens synchronously from its in-memory cache and only issues
 * `POST /app/installations/{id}/access_tokens` (via `app.octokit`) on a miss. A
 * transient `hook.before` on `app.octokit`, scoped to the mint window and the
 * route + this installation id, trips exactly once on a miss and never on a hit.
 * auth-app dedups concurrent same-installation auth into one in-flight request,
 * so the probe cannot double-count, and the installation id in the route
 * disambiguates cross-installation parallelism.
 *
 * Security: NEVER logs the token, the App JWT, or the private key. Only
 * `installation_id`, `via`, `cache_hit`, and `duration_ms` are emitted on
 * success; the failure line adds the standard pino `err` field, serialized
 * through the secret-scrubbing `errSerializer` in `src/utils/log-redaction.ts`.
 */
import type { App, Octokit } from "octokit";

import { resolveGithubToken } from "../core/github-token";
import type { Logger } from "../logger";
import { GITHUB_APP_TOKEN_LOG_EVENTS, type TokenMintVia } from "./log-fields";

/** App-octokit route the auth-app cache miss path hits to mint a token. */
const ACCESS_TOKENS_ROUTE = "POST /app/installations/{installation_id}/access_tokens";

interface MintArgs {
  readonly app: App;
  readonly installationId: number;
  readonly via: TokenMintVia;
  readonly log: Logger;
}

interface MintResult {
  readonly octokit: Octokit;
  readonly token: string;
}

/**
 * Mint (or cache-serve) an installation token, returning both the installation
 * octokit and the resolved token string so callers that need either get one
 * mint per dispatch. Emits the `github.app.token.mint.*` event family. Errors
 * propagate unchanged after the `failed` line so each call site keeps its own
 * recovery policy (mark-failed, decrement capacity, return early).
 */
export async function mintInstallationToken({
  app,
  installationId,
  via,
  log,
}: MintArgs): Promise<MintResult> {
  // A cache miss routes the access-tokens POST through `app.octokit`. The
  // before-hook receives the merged-but-unparsed endpoint options, so `url` is
  // the route template and `installation_id` is a top-level merged param. Match
  // both so a concurrent mint for a different installation does not trip us.
  let networkMint = false;
  const probe = (options: {
    method?: string;
    url?: string;
    installation_id?: string | number;
  }): void => {
    if (
      `${options.method} ${options.url}` === ACCESS_TOKENS_ROUTE &&
      Number(options.installation_id ?? installationId) === installationId
    ) {
      networkMint = true;
    }
  };

  const start = Date.now();
  app.octokit.hook.before("request", probe);
  try {
    const octokit = (await app.getInstallationOctokit(installationId)) as unknown as Octokit;
    const token = await resolveGithubToken(octokit);
    const duration_ms = Date.now() - start;
    log.info(
      {
        event: GITHUB_APP_TOKEN_LOG_EVENTS.mintSucceeded,
        installation_id: installationId,
        via,
        cache_hit: !networkMint,
        duration_ms,
      },
      "Installation token minted",
    );
    return { octokit, token };
  } catch (err) {
    const duration_ms = Date.now() - start;
    log.warn(
      {
        event: GITHUB_APP_TOKEN_LOG_EVENTS.mintFailed,
        installation_id: installationId,
        via,
        duration_ms,
        err,
      },
      "Installation token mint failed",
    );
    throw err;
  } finally {
    app.octokit.hook.remove("request", probe);
  }
}
