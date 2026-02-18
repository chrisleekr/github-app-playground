import type { Octokit } from "octokit";

import type {
  BotContext,
  ChangedFileData,
  CommentData,
  FetchedData,
  ReviewCommentData,
} from "../types";

/**
 * GraphQL query for pull request data.
 * Ported from claude-code-action's src/github/api/queries/github.ts
 *
 * LIMITATION: All connection fields use `first: 100` without cursor-based
 * pagination. PRs/issues with >100 comments, files, or reviews will have
 * data silently truncated. This matches the upstream claude-code-action
 * behavior. For very active PRs, consider implementing cursor-based
 * pagination using `pageInfo { hasNextPage endCursor }`.
 * See: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
 */
const PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
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
        files(first: 100) {
          nodes {
            path
            additions
            deletions
            changeType
          }
        }
        comments(first: 100) {
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
        }
        reviews(first: 100) {
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
            }
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for issue data.
 */
const ISSUE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        title
        body
        author { login }
        createdAt
        updatedAt
        lastEditedAt
        state
        comments(first: 100) {
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

interface GqlReview {
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
  updatedAt?: string;
  lastEditedAt?: string;
  comments: { nodes: GqlReviewComment[] };
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
      files: {
        nodes: Array<{
          path: string;
          additions: number;
          deletions: number;
          changeType: string;
        }>;
      };
      comments: { nodes: GqlComment[] };
      reviews: { nodes: GqlReview[] };
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
      comments: { nodes: GqlComment[] };
    } | null;
  };
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

/**
 * Fetch PR or issue data via GitHub GraphQL API.
 * Returns a unified FetchedData shape for the formatter.
 *
 * Ported from claude-code-action's fetchGitHubData()
 */
interface FetchParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  number: number;
  triggerTime: string;
  log: BotContext["log"];
}

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

async function fetchPRData({
  octokit,
  owner,
  repo,
  number,
  triggerTime,
  log,
}: FetchParams): Promise<FetchedData> {
  const result = await octokit.graphql<PrQueryResult>(PR_QUERY, {
    owner,
    repo,
    number,
  });

  const pr = result.repository.pullRequest;
  if (pr === null) throw new Error(`PR #${number} not found`);

  log.info({ prNumber: number }, "Fetched PR data via GraphQL");

  // Filter comments and reviews by trigger time (TOCTOU protection)
  const filteredComments = filterByTriggerTime(
    pr.comments.nodes.filter((c) => !c.isMinimized),
    triggerTime,
  );

  // Extract review comments from all reviews
  const allReviewComments = pr.reviews.nodes.flatMap((r) =>
    r.comments.nodes.filter((c) => !c.isMinimized),
  );
  const filteredReviewComments = filterByTriggerTime(allReviewComments, triggerTime);

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

  const changedFiles: ChangedFileData[] = pr.files.nodes.map((f) => ({
    filename: f.path,
    status: f.changeType,
    additions: f.additions,
    deletions: f.deletions,
  }));

  return {
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
}

async function fetchIssueData({
  octokit,
  owner,
  repo,
  number,
  triggerTime,
  log,
}: FetchParams): Promise<FetchedData> {
  const result = await octokit.graphql<IssueQueryResult>(ISSUE_QUERY, {
    owner,
    repo,
    number,
  });

  const issue = result.repository.issue;
  if (issue === null) throw new Error(`Issue #${number} not found`);

  log.info({ issueNumber: number }, "Fetched issue data via GraphQL");

  const filteredComments = filterByTriggerTime(
    issue.comments.nodes.filter((c) => !c.isMinimized),
    triggerTime,
  );

  const comments: CommentData[] = filteredComments.map((c) => ({
    author: c.author.login,
    body: c.body,
    createdAt: c.createdAt,
  }));

  return {
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    author: issue.author.login,
    comments,
    reviewComments: [],
    changedFiles: [],
  };
}
