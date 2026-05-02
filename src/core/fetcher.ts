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
 * Pagination strategy: every connection field selects
 * `pageInfo { hasNextPage endCursor }` and accepts an `$after*: String`
 * cursor variable so `octokit.graphql.paginate()` (bundled in the
 * `octokit ^5` package via `@octokit/plugin-paginate-graphql`) can walk
 * pages automatically. The fetcher stops paginating once a connection
 * reaches the matching `MAX_FETCHED_*` safety cap, then sets the
 * corresponding `FetchedData.truncated.*` flag and emits a structured
 * `log.warn({ connection, fetched, cap })`. The prompt builder surfaces
 * the truncation flags so the agent does not silently reason over a
 * partial payload.
 *
 * Nested per-review comments are paginated separately: the top-level
 * `PR_QUERY` fetches the first page of inline comments per review (up to
 * 100, GitHub's hard maximum) plus a `pageInfo`; if any review reports
 * `hasNextPage`, `REVIEW_COMMENTS_QUERY` is run per review to walk the
 * remainder.
 *
 * See: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 */
const PR_QUERY = `
  query(
    $owner: String!
    $repo: String!
    $number: Int!
    $afterFiles: String
    $afterComments: String
    $afterReviews: String
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
        files(first: 100, after: $afterFiles) {
          nodes {
            path
            additions
            deletions
            changeType
          }
          pageInfo { hasNextPage endCursor }
        }
        comments(first: 100, after: $afterComments) {
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
        reviews(first: 100, after: $afterReviews) {
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
    $afterComments: String
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
        comments(first: 100, after: $afterComments) {
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

/**
 * Walks the remaining pages of a single review's inline comments. Used
 * after the top-level PR_QUERY when a review reports `hasNextPage` on
 * its `comments` connection.
 */
const REVIEW_COMMENTS_QUERY = `
  query(
    $reviewId: ID!
    $afterComments: String
  ) {
    node(id: $reviewId) {
      ... on PullRequestReview {
        comments(first: 100, after: $afterComments) {
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

interface PrQueryResult {
  repository: {
    // GraphQL returns null when the pull request number does not exist in the repository
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
      comments: { nodes: GqlComment[]; pageInfo: GqlPageInfo };
      reviews: { nodes: GqlReview[]; pageInfo: GqlPageInfo };
    } | null;
  };
}

interface IssueQueryResult {
  repository: {
    // GraphQL returns null when the issue number does not exist in the repository
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
 * Cap the array to `max` elements, return whether truncation occurred,
 * and emit a structured warning. Connections never grow unbounded — once
 * the cap is hit we stop merging further pages.
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
  return { items: items.slice(0, cap), truncated: true };
}

/**
 * graphql.paginate response shape for a single connection: every page is
 * merged into one root by the plugin, but `pageInfo` reflects the last page.
 * We use the merged `nodes.length` against the originally-requested page
 * size to detect when the server stopped early.
 */
async function paginatePR(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PrQueryResult> {
  return octokit.graphql.paginate<PrQueryResult>(PR_QUERY, { owner, repo, number });
}

async function paginateIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<IssueQueryResult> {
  return octokit.graphql.paginate<IssueQueryResult>(ISSUE_QUERY, { owner, repo, number });
}

/**
 * Walk the remaining pages of a single review's inline comments after
 * the top-level PR_QUERY's first page. The plugin can't paginate the
 * nested connection on its own (it only follows ONE pageInfo), so we
 * issue a follow-up query keyed on the review's GraphQL node ID.
 */
async function fetchRemainingReviewComments(
  octokit: Octokit,
  reviewId: string,
  startCursor: string | null,
): Promise<GqlReviewComment[]> {
  const result = await octokit.graphql.paginate<ReviewCommentsQueryResult>(REVIEW_COMMENTS_QUERY, {
    reviewId,
    afterComments: startCursor,
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
  const result = await paginatePR(octokit, owner, repo, number);

  const pr = result.repository.pullRequest;
  if (pr === null) throw new Error(`PR #${number} not found`);

  log.info(
    {
      prNumber: number,
      comments: pr.comments.nodes.length,
      reviews: pr.reviews.nodes.length,
      changedFiles: pr.files.nodes.length,
    },
    "Fetched PR data via GraphQL",
  );

  const truncated: NonNullable<FetchedData["truncated"]> = {};

  // Apply per-connection safety caps. A cap firing means the underlying
  // connection has more items than the prompt should carry.
  const cappedComments = applyCap(pr.comments.nodes, config.maxFetchedComments, "comments", log);
  if (cappedComments.truncated) truncated.comments = true;

  const cappedReviews = applyCap(pr.reviews.nodes, config.maxFetchedReviews, "reviews", log);
  if (cappedReviews.truncated) truncated.reviews = true;

  const cappedFiles = applyCap(pr.files.nodes, config.maxFetchedFiles, "changedFiles", log);
  if (cappedFiles.truncated) truncated.changedFiles = true;

  // Walk the nested review-comments pages: any review that returned
  // hasNextPage on its first page needs a follow-up paginate call. We
  // only do this for reviews surviving the reviews-cap above, and we
  // accumulate against the per-review-comments cap once flattened.
  let allReviewComments: GqlReviewComment[] = [];
  let reviewCommentsCapHit = false;
  for (const review of cappedReviews.items) {
    let merged = review.comments.nodes;
    // pageInfo is selected by the new query but may be absent when a test
    // fixture predates the pagination wiring — treat as "no more pages".
    if (review.comments.pageInfo?.hasNextPage) {
      const remaining = await fetchRemainingReviewComments(
        octokit,
        review.id,
        review.comments.pageInfo.endCursor,
      );
      merged = [...merged, ...remaining];
    }
    allReviewComments = [...allReviewComments, ...merged];
    if (allReviewComments.length >= config.maxFetchedReviewComments) {
      reviewCommentsCapHit = true;
      break;
    }
  }
  const cappedReviewComments = applyCap(
    allReviewComments,
    config.maxFetchedReviewComments,
    "reviewComments",
    log,
  );
  if (cappedReviewComments.truncated || reviewCommentsCapHit) {
    truncated.reviewComments = true;
  }

  // TOCTOU filter — runs AFTER pagination merges, so the agent sees the
  // newest pre-trigger items (rather than the oldest 100, which is what
  // the un-paginated version surfaced).
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
  const result = await paginateIssue(octokit, owner, repo, number);

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
