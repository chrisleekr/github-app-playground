/**
 * Tests for `bot:investigate` (T077 / FR-033). Constitution V mocks
 * `octokit` and `callLlm`. ≥90% coverage on
 * `src/workflows/ship/scoped/investigate.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { runInvestigate } from "../../../../src/workflows/ship/scoped/investigate";

interface FakeIssue {
  readonly title: string;
  readonly body: string | null;
}
interface FakeComment {
  readonly id: number;
  readonly body: string | null;
  readonly user?: { login: string };
}

function buildOctokit(opts: {
  issue: FakeIssue;
  comments: readonly FakeComment[];
  existingMarkerCommentId?: number;
}) {
  const issuesGet = mock(() => Promise.resolve({ data: opts.issue }));
  const listComments = mock(() => Promise.resolve({ data: opts.comments }));
  const updateComment = mock(() =>
    Promise.resolve({ data: { id: opts.existingMarkerCommentId ?? 0 } }),
  );
  const createComment = mock(() => Promise.resolve({ data: { id: 8001 } }));

  // Investigate uses `octokit.paginate(method, opts)`, a function call,
  // not the iterator factory. Returns a flat array of every page's data.
  const paginate = mock(() => Promise.resolve(opts.comments));

  // upsertMarkerComment still uses `octokit.paginate.iterator(...)`.
  const paginateIterator = mock(() => ({
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        next: () =>
          Promise.resolve(
            yielded
              ? { value: undefined, done: true }
              : ((yielded = true),
                {
                  value: {
                    data:
                      opts.existingMarkerCommentId !== undefined
                        ? [
                            {
                              id: opts.existingMarkerCommentId,
                              body: `<!-- bot:investigate:${String(13)} -->`,
                            },
                          ]
                        : [],
                  },
                  done: false,
                }),
          ),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  }));

  // Bun's mock helpers are not callable themselves, the function we
  // need is `paginate`, with `.iterator` attached as a property. Wrap
  // it as a single object whose call signature uses `paginate` directly.
  const paginateFn = Object.assign(paginate, { iterator: paginateIterator });

  return {
    octokit: {
      rest: {
        issues: { get: issuesGet, listComments, updateComment, createComment },
      },
      paginate: paginateFn,
    } as never,
    issuesGet,
    listComments,
    updateComment,
    createComment,
    paginate,
  };
}

describe("runInvestigate", () => {
  it("posts a structured analysis comment with the marker on first trigger", async () => {
    const fake = buildOctokit({
      issue: { title: "Crash on startup", body: "stack trace ..." },
      comments: [
        { id: 1, body: "I see this too", user: { login: "alice" } },
        { id: 2, body: "Same on macOS", user: { login: "bob" } },
      ],
    });
    const callLlm = mock(() =>
      Promise.resolve(
        "### Root-cause hypothesis\nrace\n\n### Files of interest\n- foo.ts\n\n### Repro confidence\nMedium",
      ),
    );
    const result = await runInvestigate({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 12,
      callLlm,
    });
    expect(result.comment_id).toBe(8001);
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("<!-- bot:investigate:12 -->");
    expect(call.body).toContain("Root-cause");
  });

  it("updates the existing investigate comment on re-trigger (idempotency)", async () => {
    const marker = "<!-- bot:investigate:13 -->";
    const fake = buildOctokit({
      issue: { title: "x", body: "y" },
      comments: [{ id: 7777, body: `prior\n${marker}` }],
      existingMarkerCommentId: 7777,
    });
    const callLlm = mock(() => Promise.resolve("new analysis"));
    const result = await runInvestigate({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 13,
      callLlm,
    });
    expect(result.comment_id).toBe(7777);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("excludes the bot's own prior marker comment from the LLM prompt", async () => {
    const marker = "<!-- bot:investigate:14 -->";
    const fake = buildOctokit({
      issue: { title: "T", body: "B" },
      comments: [
        { id: 1, body: `prior bot output\n${marker}` },
        { id: 2, body: "real human comment", user: { login: "alice" } },
      ],
    });
    const callLlm = mock(() => Promise.resolve("new"));
    await runInvestigate({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 14,
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).not.toContain(marker);
    expect(userPrompt).toContain("real human comment");
  });

  it("notes insufficient context when the issue has no body and no comments", async () => {
    const fake = buildOctokit({
      issue: { title: "low signal", body: null },
      comments: [],
    });
    const callLlm = mock(() => Promise.resolve("**Insufficient context**, ..."));
    const result = await runInvestigate({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 15,
      callLlm,
    });
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("Insufficient context");
    expect(result.comment_id).toBe(8001);
  });

  it("handles missing user.login gracefully", async () => {
    const fake = buildOctokit({
      issue: { title: "x", body: "y" },
      comments: [{ id: 1, body: "ghost author", user: undefined }],
    });
    const callLlm = mock(() => Promise.resolve("ok"));
    await runInvestigate({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 16,
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("(unknown)");
  });
});
