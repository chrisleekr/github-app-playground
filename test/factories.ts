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
 * Options for `makeOctokit`. Either a `graphqlResponse` (returned as a
 * resolved Promise) or a `graphqlError` (returned as a rejected Promise) may
 * be supplied; if neither is set, `graphql` resolves with `undefined`.
 */
export interface MakeOctokitOptions {
  graphqlResponse?: unknown;
  graphqlError?: Error;
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
  const graphqlFn = mock(() => {
    if (opts.graphqlError !== undefined) {
      return Promise.reject(opts.graphqlError);
    }
    return Promise.resolve(opts.graphqlResponse);
  });

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
