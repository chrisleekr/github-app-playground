/**
 * Shared test factories.
 *
 * Centralizes construction of `BotContext`, `Logger`, `Octokit`, and
 * `FetchedData` test doubles. Replaces the previously-duplicated `makeCtx`,
 * `silentLog`/`makeSilentLog`, and `makeOctokit` factories that lived
 * independently in 7 test files.
 *
 * Module-level mocks (`mock.module(...)`) MUST stay in individual test files
 * because Bun persists them across the process. These factories produce data
 * structures only — no module-mock side effects.
 */

import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { mock } from "bun:test";
import type { Octokit } from "octokit";

import type { BotContext, FetchedData } from "../src/types";

/**
 * Silent logger with `mock(() => {})` spies on each method. The return type
 * is a structural intersection of the spy methods plus `BotContext["log"]`
 * so callers can both pass it where a `pino.Logger` is expected AND assert
 * on calls via `log.warn.mock.calls[...]`. `child()` returns the same logger
 * instance, so chained `log.child(...).info(...)` calls also record on the
 * parent's mocks.
 */
export type MockLogger = {
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
} & BotContext["log"];

export function makeSilentLogger(): MockLogger {
  const log = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  };
  return log as unknown as MockLogger;
}

/**
 * Options for `makeOctokit`.
 *
 * - `graphqlResponse` / `graphqlError` control the base `octokit.graphql(...)`
 *   call shape. They are also used as the default fall-through for
 *   `octokit.graphql.paginate(...)` when no `graphqlPaginateResponses` map is
 *   set, which keeps the existing single-page tests working unchanged.
 * - `graphqlPaginateResponses` maps a query string (or a stable substring,
 *   e.g. `"PullRequestReview"` for the nested review-comments query) to the
 *   merged paginated response object the test wants `paginate()` to return.
 *   The first matching key wins; if no key matches, the call falls back to
 *   `graphqlResponse`. This mirrors what `@octokit/plugin-paginate-graphql`
 *   does in production: it merges every page into a single object and hands
 *   that to the caller, so tests need only describe the merged result, not
 *   per-page chunks.
 * - `useRealPaginatePlugin` wires the real `@octokit/plugin-paginate-graphql`
 *   on top of the mocked `graphql()` so cursor-name + single-pageInfo
 *   contract violations actually throw. Use with `graphqlPagesByQuery` to
 *   describe per-page chunks the stubbed `graphql()` returns; the plugin
 *   walks them via the `cursor` parameter exactly as it does in production.
 */
export interface MakeOctokitOptions {
  graphqlResponse?: unknown;
  graphqlError?: Error;
  graphqlPaginateResponses?: Record<string, unknown>;
  useRealPaginatePlugin?: boolean;
  /** Per-query page sequences. Keys are matched as substrings of the query string. */
  graphqlPagesByQuery?: Record<string, unknown[]>;
}

/**
 * Construct a minimal `Octokit` test double covering both the GraphQL and
 * REST surfaces used by router/fetcher tests. The returned object is cast
 * via `unknown` because the real `Octokit` type is wide and unit tests need
 * only a small subset. Tests that need custom REST behavior can either
 * pass an `octokit` override to `makeBotContext` or reassign `ctx.octokit`
 * after construction.
 */
export function makeOctokit(opts: MakeOctokitOptions = {}): Octokit {
  // Real-plugin path: stubbed `graphql()` returns one page at a time per
  // query, the real `@octokit/plugin-paginate-graphql` walks the cursor.
  // This catches contract regressions (wrong `$cursor` name, multiple
  // `pageInfo` blocks per query) that the canned-merged-response path
  // cannot distinguish from a correct implementation.
  if (opts.useRealPaginatePlugin === true) {
    const pageIndexByKey = new Map<string, number>();
    const graphqlFn = mock((query: string) => {
      if (opts.graphqlError !== undefined) {
        return Promise.reject(opts.graphqlError);
      }
      if (opts.graphqlPagesByQuery !== undefined) {
        for (const [key, pages] of Object.entries(opts.graphqlPagesByQuery)) {
          if (typeof query === "string" && query.includes(key)) {
            const idx = pageIndexByKey.get(key) ?? 0;
            const page = pages[Math.min(idx, pages.length - 1)];
            pageIndexByKey.set(key, idx + 1);
            return Promise.resolve(page);
          }
        }
      }
      return Promise.resolve(opts.graphqlResponse);
    }) as unknown as Octokit["graphql"];
    const stub = { graphql: graphqlFn } as unknown as Octokit;
    const { graphql: paginatingGraphql } = paginateGraphQL(stub);
    return {
      graphql: paginatingGraphql,
      rest: {
        issues: {
          createComment: mock(() => Promise.resolve({ data: { id: 1 } })),
          listComments: mock(() => Promise.resolve({ data: [] })),
        },
      },
    } as unknown as Octokit;
  }

  const graphqlFn = mock((query: string) => {
    if (opts.graphqlError !== undefined) {
      return Promise.reject(opts.graphqlError);
    }
    if (opts.graphqlPaginateResponses !== undefined) {
      for (const [key, value] of Object.entries(opts.graphqlPaginateResponses)) {
        if (typeof query === "string" && query.includes(key)) {
          return Promise.resolve(value);
        }
      }
    }
    return Promise.resolve(opts.graphqlResponse);
  }) as unknown as Octokit["graphql"];

  // graphql.paginate exists at runtime via @octokit/plugin-paginate-graphql.
  // For tests, a paginated call is indistinguishable from a single-page call —
  // the plugin merges pages before resolving, so the test fixture just hands
  // back the already-merged result. Routing by query substring lets the same
  // octokit double answer the top-level PR query AND the nested
  // review-comments follow-up with different payloads.
  const paginateFn = mock((query: string) => {
    if (opts.graphqlError !== undefined) {
      return Promise.reject(opts.graphqlError);
    }
    if (opts.graphqlPaginateResponses !== undefined) {
      for (const [key, value] of Object.entries(opts.graphqlPaginateResponses)) {
        if (typeof query === "string" && query.includes(key)) {
          return Promise.resolve(value);
        }
      }
    }
    return Promise.resolve(opts.graphqlResponse);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (graphqlFn as any).paginate = paginateFn;

  return {
    graphql: graphqlFn,
    rest: {
      issues: {
        createComment: mock(() => Promise.resolve({ data: { id: 1 } })),
        listComments: mock(() => Promise.resolve({ data: [] })),
      },
    },
  } as unknown as Octokit;
}

/**
 * Build a `BotContext` test fixture. Default values mirror the union of
 * defaults used across the previously-duplicated `makeCtx` factories.
 * Pass `overrides` to customize any field, including nested `octokit`/`log`.
 */
export function makeBotContext(overrides: Partial<BotContext> = {}): BotContext {
  const base: BotContext = {
    owner: "myorg",
    repo: "myrepo",
    entityNumber: 42,
    isPR: false,
    eventName: "issue_comment",
    triggerUsername: "tester",
    triggerTimestamp: "2025-01-01T00:00:00Z",
    triggerBody: "@chrisleekr-bot help",
    commentId: 1,
    deliveryId: "test-delivery",
    defaultBranch: "main",
    labels: [],
    octokit: makeOctokit(),
    log: makeSilentLogger(),
  };
  return { ...base, ...overrides };
}

/**
 * Build a `FetchedData` test fixture. Defaults represent an issue
 * (no `headBranch`/`baseBranch`/`headSha`); callers needing PR data should
 * pass those fields via `overrides`.
 */
export function makeFetchedData(overrides: Partial<FetchedData> = {}): FetchedData {
  return {
    title: "Title",
    body: "Body",
    state: "OPEN",
    author: "tester",
    comments: [],
    reviewComments: [],
    changedFiles: [],
    ...overrides,
  };
}
