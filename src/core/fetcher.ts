import type { Octokit } from "octokit";

import { config } from "../config";
import type {
  BotContext,
  ChangedFileData,
  CommentData,
  FetchedData,
  ReviewCommentData,
} from "../types";

/**
 * GraphQL queries for pull-request and issue data.
 *
 * Pagination contract — `@octokit/plugin-paginate-graphql` is strict:
 *
 *   1. The cursor variable MUST be named exactly `$cursor`. The plugin
 *      mutates `parameters.cursor` between pages (see
 *      `node_modules/@octokit/plugin-paginate-graphql/dist-src/iterator.js`),
 *      so any other name (e.g. `$afterFiles`) leaves the query parameter
 *      stuck at `null` and the plugin throws `MissingCursorChange` on the
 *      second iteration.
 *   2. Each query MUST contain at most ONE paginatable connection.
 *      `extractPageInfos` does a depth-first search for the first
 *      `pageInfo` block and ignores all others — combining files +
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
 * newest items live at the end of the merged array — slicing the tail
 * keeps the discussion turns the agent is most likely to need (including,
 * crucially, the comment that triggered the bot).
 *
 * Emits a structured warning whenever truncation fires so operators can
 * tell that a `MAX_FETCHED_*` cap is materially clipping context.
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
 * Walk the remaining pages of a single review's inline comments after
 * the top-level PR_REVIEWS_QUERY's first page. The plugin can't paginate
 * the nested connection on its own (it only follows ONE pageInfo per
 * query), so we issue a follow-up query keyed on the review's GraphQL
 * node ID with `$cursor` named per the plugin's contract.
 */
async function fetchRemainingReviewComments(
  octokit: Octokit,
  reviewId: string,
  startCursor: string | null,
): Promise<GqlReviewComment[]> {
  const result = await octokit.graphql.paginate<ReviewCommentsQueryResult>(REVIEW_COMMENTS_QUERY, {
    reviewId,
    cursor: startCursor,
  });
  return result.node?.comments.nodes ?? [];
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
  const vars = { owner, repo, number };
  const [first, commentsResult, reviewsResult] = await Promise.all([
    octokit.graphql.paginate<PrFirstQueryResult>(PR_FIRST_QUERY, vars),
    octokit.graphql.paginate<PrCommentsQueryResult>(PR_COMMENTS_QUERY, vars),
    octokit.graphql.paginate<PrReviewsQueryResult>(PR_REVIEWS_QUERY, vars),
  ]);

  const pr = first.repository.pullRequest;
  if (pr === null) throw new Error(`PR #${number} not found`);

  // The comments / reviews paginate calls are independent — if the PR
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

  const cappedComments = applyCap(prComments, config.maxFetchedComments, "comments", log);
  if (cappedComments.truncated) truncated.comments = true;

  const cappedReviews = applyCap(prReviews, config.maxFetchedReviews, "reviews", log);
  if (cappedReviews.truncated) truncated.reviews = true;

  const cappedFiles = applyCap(pr.files.nodes, config.maxFetchedFiles, "changedFiles", log);
  if (cappedFiles.truncated) truncated.changedFiles = true;

  // Walk nested review-comments pages: any review reporting hasNextPage
  // on its first page needs a follow-up paginate call. Issued in parallel
  // — these are independent GraphQL requests keyed on review node IDs.
  // pageInfo is always selected by PR_REVIEWS_QUERY, but legacy test
  // fixtures elide it — `?.` keeps those tests working without forcing a
  // sweep, at the cost of one redundant chain in production.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const overflowReviews = cappedReviews.items.filter((r) => r.comments.pageInfo?.hasNextPage);
  const overflowResults = await Promise.all(
    overflowReviews.map((r) =>
      fetchRemainingReviewComments(octokit, r.id, r.comments.pageInfo.endCursor),
    ),
  );
  const overflowByReviewId = new Map<string, GqlReviewComment[]>();
  overflowReviews.forEach((r, i) => {
    overflowByReviewId.set(r.id, overflowResults[i] ?? []);
  });

  const allReviewComments: GqlReviewComment[] = cappedReviews.items.flatMap((review) => [
    ...review.comments.nodes,
    ...(overflowByReviewId.get(review.id) ?? []),
  ]);
  const cappedReviewComments = applyCap(
    allReviewComments,
    config.maxFetchedReviewComments,
    "reviewComments",
    log,
  );
  if (cappedReviewComments.truncated) {
    truncated.reviewComments = true;
  }

  // TOCTOU filter — runs AFTER pagination merges + cap, so the agent sees
  // the newest pre-trigger items rather than the oldest 100 (which is
  // what the un-paginated version surfaced).
  const filteredComments = filterByTriggerTime(
    cappedComments.items.filter((c) => !c.isMinimized),
    triggerTime,
  );
  const filteredReviewComments = filterByTriggerTime(
    cappedReviewComments.items.filter((c) => !c.isMinimized),
    triggerTime,
  );

  const comments: CommentData[] = filteredComments.map((c) => ({
    author: c.author.login,
    body: c.body,
    createdAt: c.createdAt,
  }));

  const reviewComments: ReviewCommentData[] = filteredReviewComments.map((c) => {
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

  const capped = applyCap(issue.comments.nodes, config.maxFetchedComments, "comments", log);
  if (capped.truncated) truncated.comments = true;

  const filteredComments = filterByTriggerTime(
    capped.items.filter((c) => !c.isMinimized),
    triggerTime,
  );

  const comments: CommentData[] = filteredComments.map((c) => ({
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
