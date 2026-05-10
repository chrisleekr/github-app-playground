import type { Octokit } from "octokit";

import { config } from "../config";
import type {
  BotContext,
  ChangedFileData,
  CommentData,
  FetchedData,
  ReviewCommentData,
} from "../types";
import { retryWithBackoff } from "../utils/retry";

/** Bound on per-review overflow fan-out, prevents one large PR from
 *  spawning hundreds of concurrent GraphQL calls and tripping abuse limits.
 *  5 mirrors what `octokit.graphql.paginate` itself does for top-level pages. */
const REVIEW_OVERFLOW_CONCURRENCY = 5;

/**
 * GraphQL queries for pull-request and issue data.
 *
 * Pagination contract: `@octokit/plugin-paginate-graphql` is strict:
 *
 *   1. The cursor variable MUST be named exactly `$cursor`. The plugin
 *      mutates `parameters.cursor` between pages (see
 *      `node_modules/@octokit/plugin-paginate-graphql/dist-src/iterator.js`),
 *      so any other name (e.g. `$afterFiles`) leaves the query parameter
 *      stuck at `null` and the plugin throws `MissingCursorChange` on the
 *      second iteration.
 *   2. Each query MUST contain at most ONE paginatable connection.
 *      `extractPageInfos` does a depth-first search for the first
 *      `pageInfo` block and ignores all others: combining files +
 *      comments + reviews in one query silently truncates two of the
 *      three to page 1.
 *
 * The PR fetch therefore issues three parallel `paginate(...)` calls
 * (`PR_FIRST_QUERY` for top-level fields + files, `PR_COMMENTS_QUERY`,
 * `PR_REVIEWS_QUERY`). Top-level PR fields ride along on `PR_FIRST_QUERY`
 * because the plugin's `mergeResponses` preserves non-paginated fields
 * from the first page. Nested per-review inline comments are walked
 * separately by `REVIEW_COMMENTS_QUERY` keyed on the review's node ID.
 *
 * See: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 */
const PR_FIRST_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        title
        body
        author { login }
        baseRefName
        headRefName
        headRefOid
        createdAt
        updatedAt
        lastEditedAt
        additions
        deletions
        state
        commits(first: 100) { totalCount }
        files(first: 100, after: $cursor) {
          nodes {
            path
            additions
            deletions
            changeType
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const PR_COMMENTS_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            body
            author { login }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const PR_REVIEWS_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            author { login }
            body
            state
            submittedAt
            updatedAt
            lastEditedAt
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                path
                line
                author { login }
                createdAt
                updatedAt
                lastEditedAt
                isMinimized
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        title
        body
        author { login }
        createdAt
        updatedAt
        lastEditedAt
        state
        comments(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            body
            author { login }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const REVIEW_COMMENTS_QUERY = `
  query(
    $reviewId: ID!
    $cursor: String
  ) {
    node(id: $reviewId) {
      ... on PullRequestReview {
        comments(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            body
            path
            line
            author { login }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

/** GraphQL response types */
interface GqlComment {
  body: string;
  author: { login: string };
  createdAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  isMinimized: boolean;
}

interface GqlReviewComment extends GqlComment {
  path: string;
  line: number | null;
}

interface GqlChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlReview {
  id: string;
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  comments: { nodes: GqlReviewComment[]; pageInfo: GqlPageInfo };
}

/** Top-level PR fields + paginated `files` connection. */
interface PrFirstQueryResult {
  repository: {
    pullRequest: {
      title: string;
      body: string | null;
      author: { login: string };
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      createdAt: string;
      updatedAt: string;
      lastEditedAt: string | null;
      additions: number;
      deletions: number;
      state: string;
      commits: { totalCount: number };
      files: { nodes: GqlChangedFile[]; pageInfo: GqlPageInfo };
    } | null;
  };
}

interface PrCommentsQueryResult {
  repository: {
    pullRequest: {
      comments: { nodes: GqlComment[]; pageInfo: GqlPageInfo };
    } | null;
  };
}

interface PrReviewsQueryResult {
  repository: {
    pullRequest: {
      reviews: { nodes: GqlReview[]; pageInfo: GqlPageInfo };
    } | null;
  };
}

interface IssueQueryResult {
  repository: {
    issue: {
      title: string;
      body: string | null;
      author: { login: string };
      createdAt: string;
      updatedAt: string;
      lastEditedAt: string | null;
      state: string;
      comments: { nodes: GqlComment[]; pageInfo: GqlPageInfo };
    } | null;
  };
}

interface ReviewCommentsQueryResult {
  node: {
    comments: { nodes: GqlReviewComment[]; pageInfo: GqlPageInfo };
  } | null;
}

/**
 * Filter comments to only include those created before the trigger time.
 * TOCTOU protection: prevents reading content edited after the trigger.
 *
 * Exported for unit testing of the TOCTOU filter logic.
 * Ported from claude-code-action's filterCommentsToTriggerTime()
 */
export function filterByTriggerTime<
  T extends { createdAt: string; updatedAt?: string; lastEditedAt?: string },
>(items: T[], triggerTime: string): T[] {
  const triggerTs = new Date(triggerTime).getTime();

  return items.filter((item) => {
    // Must be created before trigger
    if (new Date(item.createdAt).getTime() >= triggerTs) return false;

    // If edited, the edit must also be before trigger
    const lastEdit = item.lastEditedAt ?? item.updatedAt;
    if (lastEdit !== undefined && lastEdit !== "" && new Date(lastEdit).getTime() >= triggerTs)
      return false;

    return true;
  });
}

interface FetchParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  number: number;
  triggerTime: string;
  log: BotContext["log"];
}

/**
 * Fetch PR or issue data via GitHub GraphQL API.
 * Returns a unified FetchedData shape for the formatter.
 */
export async function fetchGitHubData(ctx: BotContext): Promise<FetchedData> {
  const { octokit, owner, repo, entityNumber, isPR, triggerTimestamp, log } = ctx;
  const params: FetchParams = {
    octokit,
    owner,
    repo,
    number: entityNumber,
    triggerTime: triggerTimestamp,
    log,
  };

  if (isPR) {
    return fetchPRData(params);
  }
  return fetchIssueData(params);
}

/**
 * Trim `items` to the most recent `cap` entries. GitHub's GraphQL
 * connections return ASC by `createdAt`/`submittedAt` by default, so the
 * newest items live at the end of the merged array: slicing the tail
 * keeps the discussion turns the agent is most likely to need (including,
 * crucially, the comment that triggered the bot).
 *
 * Emits a structured warning whenever truncation fires so operators can
 * tell that a `MAX_FETCHED_*` cap is materially clipping context.
 *
 * Caller is responsible for filtering (isMinimized, TOCTOU) BEFORE invoking
 * this: the cap measures items that will actually reach the prompt, not
 * raw GraphQL nodes that the next step is about to drop.
 */
function applyCap<T>(
  items: T[],
  cap: number,
  connection: string,
  log: BotContext["log"],
): { items: T[]; truncated: boolean } {
  if (items.length <= cap) return { items, truncated: false };
  log.warn(
    { connection, fetched: items.length, cap },
    `Fetched ${connection} exceeded MAX_FETCHED cap; truncating to ${String(cap)}`,
  );
  return { items: items.slice(-cap), truncated: true };
}

/**
 * Run `fn` over `items` with at most `concurrency` in-flight at any time.
 * Preserves input order in the result. Used to bound the per-review overflow
 * fan-out (see `REVIEW_OVERFLOW_CONCURRENCY`) so a 500-review PR does not
 * spawn 500 simultaneous GraphQL pagination calls.
 */
async function pMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length) },
    async () => {
      for (;;) {
        const idx = next;
        next += 1;
        if (idx >= items.length) return;
        // eslint-disable-next-line security/detect-object-injection, @typescript-eslint/no-non-null-assertion, no-await-in-loop
        results[idx] = await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Walk the remaining pages of a single review's inline comments after
 * the top-level PR_REVIEWS_QUERY's first page. The plugin can't paginate
 * the nested connection on its own (it only follows ONE pageInfo per
 * query), so we issue a follow-up query keyed on the review's GraphQL
 * node ID with `$cursor` named per the plugin's contract.
 *
 * Wrapped in `retryWithBackoff` so a transient 5xx / 429 on one review's
 * follow-up doesn't fail the entire fetch. After all retries exhaust we
 * log a warn and return an empty page: the agent will see the first 100
 * inline comments for that review with no further degradation.
 */
async function fetchRemainingReviewComments(
  octokit: Octokit,
  reviewId: string,
  startCursor: string | null,
  log: BotContext["log"],
): Promise<GqlReviewComment[]> {
  try {
    const result = await retryWithBackoff(
      () =>
        octokit.graphql.paginate<ReviewCommentsQueryResult>(REVIEW_COMMENTS_QUERY, {
          reviewId,
          cursor: startCursor,
        }),
      { log },
    );
    return result.node?.comments.nodes ?? [];
  } catch (err) {
    log.warn(
      { reviewId, err: err instanceof Error ? err.message : String(err) },
      "Failed to fetch remaining review comments after retries; degrading gracefully",
    );
    return [];
  }
}

async function fetchPRData({
  octokit,
  owner,
  repo,
  number,
  triggerTime,
  log,
}: FetchParams): Promise<FetchedData> {
  // Three parallel paginate calls. Each query has exactly one pageInfo
  // and uses `$cursor`, satisfying the plugin's contract. Top-level PR
  // fields ride along on PR_FIRST_QUERY because mergeResponses preserves
  // non-paginated fields from the first page.
  //
  // Each call gets its OWN parameters object literal: the plugin mutates
  // `parameters.cursor` between pages, so a shared object would race
  // across the three concurrent paginations and corrupt cursors.
  const [first, commentsResult, reviewsResult] = await Promise.all([
    octokit.graphql.paginate<PrFirstQueryResult>(PR_FIRST_QUERY, { owner, repo, number }),
    octokit.graphql.paginate<PrCommentsQueryResult>(PR_COMMENTS_QUERY, { owner, repo, number }),
    octokit.graphql.paginate<PrReviewsQueryResult>(PR_REVIEWS_QUERY, { owner, repo, number }),
  ]);

  const pr = first.repository.pullRequest;
  if (pr === null) throw new Error(`PR #${number} not found`);

  // The comments / reviews paginate calls are independent, if the PR
  // disappeared between calls (deleted mid-flight) one of these could
  // come back null. Treat as empty rather than throwing twice.
  const prComments = commentsResult.repository.pullRequest?.comments.nodes ?? [];
  const prReviews = reviewsResult.repository.pullRequest?.reviews.nodes ?? [];

  log.info(
    {
      prNumber: number,
      comments: prComments.length,
      reviews: prReviews.length,
      changedFiles: pr.files.nodes.length,
    },
    "Fetched PR data via GraphQL",
  );

  const truncated: NonNullable<FetchedData["truncated"]> = {};

  // Reviews cap is applied here (pre-fan-out) because its purpose is to
  // bound the cost of the follow-up REVIEW_COMMENTS_QUERY fan-out, not to
  // shape user-visible output. Reviews themselves don't appear in
  // FetchedData, only their nested inline comments do, and those are
  // filtered + capped separately below.
  const cappedReviews = applyCap(prReviews, config.maxFetchedReviews, "reviews", log);
  if (cappedReviews.truncated) truncated.reviews = true;

  // Walk nested review-comments pages: any review reporting hasNextPage
  // on its first page needs a follow-up paginate call. Bounded concurrency
  // (REVIEW_OVERFLOW_CONCURRENCY) prevents a 500-review PR from spawning
  // 500 simultaneous GraphQL requests; each call is wrapped in
  // retryWithBackoff so transient 5xx/429s degrade per-review instead of
  // failing the whole fetch.
  // pageInfo is always selected by PR_REVIEWS_QUERY, but legacy test
  // fixtures elide it, `?.` keeps those tests working without forcing a
  // sweep, at the cost of one redundant chain in production.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const overflowReviews = cappedReviews.items.filter((r) => r.comments.pageInfo?.hasNextPage);
  const overflowResults = await pMap(overflowReviews, REVIEW_OVERFLOW_CONCURRENCY, (r) =>
    fetchRemainingReviewComments(octokit, r.id, r.comments.pageInfo.endCursor, log),
  );
  const overflowByReviewId = new Map<string, GqlReviewComment[]>();
  overflowReviews.forEach((r, i) => {
    // eslint-disable-next-line security/detect-object-injection
    overflowByReviewId.set(r.id, overflowResults[i] ?? []);
  });

  const allReviewComments: GqlReviewComment[] = cappedReviews.items.flatMap((review) => [
    ...review.comments.nodes,
    ...(overflowByReviewId.get(review.id) ?? []),
  ]);

  // Filter BEFORE capping so the cap reflects items that actually reach
  // the prompt: minimized comments and post-trigger items (TOCTOU) never
  // count toward MAX_FETCHED_*. Without this, a busy PR with hundreds of
  // post-trigger comments would fill the cap with items the next step
  // drops, leaving little or no pre-trigger context for the agent.
  const filteredComments = filterByTriggerTime(
    prComments.filter((c) => !c.isMinimized),
    triggerTime,
  );
  const filteredReviewComments = filterByTriggerTime(
    allReviewComments.filter((c) => !c.isMinimized),
    triggerTime,
  );

  const cappedComments = applyCap(filteredComments, config.maxFetchedComments, "comments", log);
  if (cappedComments.truncated) truncated.comments = true;

  const cappedReviewComments = applyCap(
    filteredReviewComments,
    config.maxFetchedReviewComments,
    "reviewComments",
    log,
  );
  if (cappedReviewComments.truncated) truncated.reviewComments = true;

  const cappedFiles = applyCap(pr.files.nodes, config.maxFetchedFiles, "changedFiles", log);
  if (cappedFiles.truncated) truncated.changedFiles = true;

  const comments: CommentData[] = cappedComments.items.map((c) => ({
    author: c.author.login,
    body: c.body,
    createdAt: c.createdAt,
  }));

  const reviewComments: ReviewCommentData[] = cappedReviewComments.items.map((c) => {
    const comment: ReviewCommentData = {
      author: c.author.login,
      body: c.body,
      path: c.path,
      createdAt: c.createdAt,
    };
    // Only set line when present (exactOptionalPropertyTypes forbids explicit undefined)
    if (c.line !== null) {
      comment.line = c.line;
    }
    return comment;
  });

  const changedFiles: ChangedFileData[] = cappedFiles.items.map((f) => ({
    filename: f.path,
    status: f.changeType,
    additions: f.additions,
    deletions: f.deletions,
  }));

  const data: FetchedData = {
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    author: pr.author.login,
    comments,
    reviewComments,
    changedFiles,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    headSha: pr.headRefOid,
  };
  if (Object.keys(truncated).length > 0) data.truncated = truncated;
  return data;
}

async function fetchIssueData({
  octokit,
  owner,
  repo,
  number,
  triggerTime,
  log,
}: FetchParams): Promise<FetchedData> {
  const result = await octokit.graphql.paginate<IssueQueryResult>(ISSUE_QUERY, {
    owner,
    repo,
    number,
  });

  const issue = result.repository.issue;
  if (issue === null) throw new Error(`Issue #${number} not found`);

  log.info(
    { issueNumber: number, comments: issue.comments.nodes.length },
    "Fetched issue data via GraphQL",
  );

  const truncated: NonNullable<FetchedData["truncated"]> = {};

  const filteredComments = filterByTriggerTime(
    issue.comments.nodes.filter((c) => !c.isMinimized),
    triggerTime,
  );

  const cappedComments = applyCap(filteredComments, config.maxFetchedComments, "comments", log);
  if (cappedComments.truncated) truncated.comments = true;

  const comments: CommentData[] = cappedComments.items.map((c) => ({
    author: c.author.login,
    body: c.body,
    createdAt: c.createdAt,
  }));

  const data: FetchedData = {
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    author: issue.author.login,
    comments,
    reviewComments: [],
    changedFiles: [],
  };
  if (Object.keys(truncated).length > 0) data.truncated = truncated;
  return data;
}
