/**
 * Tests for `bot:summarize` (T075 / FR-031). Constitution V mocks
 * `octokit` and `callLlm` so no real API calls are made. ≥90% line +
 * function coverage on `src/workflows/ship/scoped/summarize.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { runSummarize } from "../../../../src/workflows/ship/scoped/summarize";

interface FakePr {
  readonly title: string;
  readonly state: "open" | "closed";
  readonly merged?: boolean;
  readonly body: string | null;
  readonly commits: number;
  readonly changed_files: number;
  readonly additions: number;
  readonly deletions: number;
}

function buildOctokit(opts: { pr: FakePr; existingMarkerCommentId?: number }) {
  const get = mock(() => Promise.resolve({ data: opts.pr }));
  const updateComment = mock(() =>
    Promise.resolve({ data: { id: opts.existingMarkerCommentId ?? 0 } }),
  );
  const createComment = mock(() => Promise.resolve({ data: { id: 9001 } }));

  const pages: { id: number; body: string | null }[][] =
    opts.existingMarkerCommentId === undefined
      ? [[]]
      : [[{ id: opts.existingMarkerCommentId, body: "<!-- bot:summarize:42 -->" }]];

  const paginateIterator = mock(() => ({
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          Promise.resolve(
            i < pages.length
              ? { value: { data: pages[i++] }, done: false }
              : { value: undefined, done: true },
          ),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  }));

  return {
    octokit: {
      rest: {
        pulls: { get },
        issues: {
          listComments: mock(() => Promise.resolve({ data: pages[0] ?? [] })),
          updateComment,
          createComment,
        },
      },
      paginate: { iterator: paginateIterator },
    } as never,
    get,
    updateComment,
    createComment,
  };
}

describe("runSummarize", () => {
  const pr: FakePr = {
    title: "Add foo",
    state: "open",
    body: "This adds foo.",
    commits: 3,
    changed_files: 5,
    additions: 100,
    deletions: 20,
  };

  it("creates a new comment with the marker on first trigger", async () => {
    const fake = buildOctokit({ pr });
    const callLlm = mock(() =>
      Promise.resolve("### Intent\nadd foo\n\n### Notable changes\n- x\n\n### Risk surface\nlow"),
    );
    const result = await runSummarize({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 42,
      callLlm,
    });
    expect(result.comment_id).toBe(9001);
    expect(fake.createComment).toHaveBeenCalledTimes(1);
    expect(fake.updateComment).not.toHaveBeenCalled();
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("<!-- bot:summarize:42 -->");
  });

  it("updates the existing comment in place on re-trigger", async () => {
    const fake = buildOctokit({ pr, existingMarkerCommentId: 5005 });
    const callLlm = mock(() => Promise.resolve("updated summary"));
    const result = await runSummarize({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 42,
      callLlm,
    });
    expect(result.comment_id).toBe(5005);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("includes a closed-state prefix when the PR is closed", async () => {
    const fake = buildOctokit({ pr: { ...pr, state: "closed" } });
    const callLlm = mock(() => Promise.resolve("body"));
    await runSummarize({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 42,
      callLlm,
    });
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("read-only");
    expect(call.body).toContain("closed");
  });

  it("includes a merged-state prefix when the PR is merged", async () => {
    const fake = buildOctokit({ pr: { ...pr, state: "closed", merged: true } });
    const callLlm = mock(() => Promise.resolve("body"));
    await runSummarize({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 42,
      callLlm,
    });
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("merged");
  });

  it("handles a PR with empty body without crashing", async () => {
    const fake = buildOctokit({ pr: { ...pr, body: null } });
    const callLlm = mock(() => Promise.resolve("_No changes detected; nothing to summarise._"));
    const res = await runSummarize({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 42,
      callLlm,
    });
    expect(res.comment_id).toBe(9001);
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("(no description)");
  });
});
