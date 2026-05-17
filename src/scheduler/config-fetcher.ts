/**
 * Fetch and validate a repo's `.github-app.yaml`.
 *
 * Reads the file from the repo's default branch via the REST contents API,
 * base64-decodes it, parses the YAML, and validates it against
 * `githubAppConfigSchema`. Any failure (404, non-file path, YAML error,
 * schema error) returns `null` and is logged: the caller skips that repo
 * for the tick rather than crashing the scan.
 *
 * Conditional requests: the fetcher keeps an in-process ETag cache. An
 * unchanged config costs a 304 with no body re-parse, keeping the per-tick
 * enumeration cheap as the number of installed repos grows.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";

import { type GithubAppConfig, githubAppConfigSchema } from "./config-schema";

export interface FetchedRepoConfig {
  readonly config: GithubAppConfig;
  /** Blob SHA of the file, recorded on the schedule-state row. */
  readonly sha: string;
}

export interface FetchRepoConfigInput {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  /** Config filename, from `config.schedulerConfigFile`. */
  readonly path: string;
  readonly log: Logger;
}

interface CacheEntry {
  readonly etag: string;
  readonly value: FetchedRepoConfig;
}

// Keyed by `${owner}/${repo}/${path}`. Per-process; multi-replica
// deployments each keep their own cache, which is fine: the cache only
// saves a body re-parse, not correctness.
const etagCache = new Map<string, CacheEntry>();

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err
    ? (err as { status?: number }).status
    : undefined;
}

/**
 * Fetch + validate `.github-app.yaml` for one repo. Returns `null` when the
 * file is absent or invalid (logged); never throws.
 */
export async function fetchRepoConfig(
  input: FetchRepoConfigInput,
): Promise<FetchedRepoConfig | null> {
  const { octokit, owner, repo, path, log } = input;
  const cacheKey = `${owner}/${repo}/${path}`;
  const cached = etagCache.get(cacheKey);

  let res;
  try {
    res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(cached !== undefined ? { headers: { "if-none-match": cached.etag } } : {}),
    });
  } catch (err) {
    const status = statusOf(err);
    if (status === 304 && cached !== undefined) {
      return cached.value; // unchanged since last fetch
    }
    if (status !== 404) {
      log.warn({ err, owner, repo }, "scheduler: getContent failed");
    }
    return null;
  }

  const data = res.data;
  if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
    log.warn({ owner, repo }, "scheduler: config path is not a file");
    return null;
  }

  const raw = Buffer.from(data.content, "base64").toString("utf-8");
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (err) {
    log.warn({ err, owner, repo }, "scheduler: YAML parse failed");
    return null;
  }

  const result = githubAppConfigSchema.safeParse(parsedYaml);
  if (!result.success) {
    log.warn(
      { owner, repo, issues: result.error.issues },
      "scheduler: .github-app.yaml validation failed",
    );
    return null;
  }

  const value: FetchedRepoConfig = { config: result.data, sha: data.sha };
  const etag = res.headers.etag;
  if (typeof etag === "string" && etag.length > 0) {
    etagCache.set(cacheKey, { etag, value });
  }
  return value;
}
