/**
 * Tests for `bot:open-pr` (T079 / FR-035). ≥90% coverage on
 * `src/workflows/ship/scoped/open-pr.ts`. The meta-issue classifier
 * is covered separately by meta-issue-classifier.test.ts.
 */

import { describe, expect, it, mock } from "bun:test";

import { runOpenPr } from "../../../../src/workflows/ship/scoped/open-pr";

interface FakeIssue {
  readonly title: string;
  readonly body: string | null;
}

function buildOctokit(opts: { issue: FakeIssue; existingBackLinkBody?: string }) {
  const issuesGet = mock(() => Promise.resolve({ data: opts.issue }));
  const createComment = mock(() =>
    Promise.resolve({ data: { id: Math.floor(Math.random() * 100_000) + 1 } }),
  );

  const pages: { id: number; body: string | null }[][] =
    opts.existingBackLinkBody === undefined
      ? [[]]
      : [[{ id: 5050, body: opts.existingBackLinkBody }]];

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
        issues: {
          get: issuesGet,
          listComments: mock(() => Promise.resolve({ data: pages[0] ?? [] })),
          createComment,
        },
      },
      paginate: { iterator: paginateIterator },
    } as never,
    issuesGet,
    createComment,
  };
}

describe("runOpenPr", () => {
  it("opens a draft PR for an actionable bug and posts the back-link marker", async () => {
    const fake = buildOctokit({ issue: { title: "Crash on x", body: "stack" } });
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "bug", reason: "concrete crash" })),
    );
    const createBranchAndPr = mock(() =>
      Promise.resolve({
        pr_number: 99,
        branch_name: "bot/fix-issue-12",
        pr_url: "https://github.com/o/r/pull/99",
      }),
    );
    const out = await runOpenPr({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 12,
      callLlm,
      createBranchAndPr,
    });
    if (out.kind !== "opened") throw new Error("expected opened outcome");
    expect(out.pr_number).toBe(99);
    expect(createBranchAndPr).toHaveBeenCalledTimes(1);
    expect(fake.createComment).toHaveBeenCalledTimes(1);
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("<!-- bot:open-pr:99 -->");
    expect(body).toContain("https://github.com/o/r/pull/99");
  });

  it("refuses on a non-actionable issue (e.g. tracking) without creating a branch", async () => {
    const fake = buildOctokit({ issue: { title: "Q4 roadmap", body: "..." } });
    const callLlm = mock(() =>
      Promise.resolve(
        JSON.stringify({ actionable: false, kind: "roadmap", reason: "not a single PR" }),
      ),
    );
    const createBranchAndPr = mock(() => Promise.reject(new Error("must not be called")));
    const out = await runOpenPr({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 13,
      callLlm,
      createBranchAndPr,
    });
    if (out.kind !== "non-actionable") throw new Error("expected non-actionable");
    expect(out.verdict.kind).toBe("roadmap");
    expect(createBranchAndPr).not.toHaveBeenCalled();
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("not a single PR");
  });

  it("detects an existing back-link marker and refuses to create a duplicate", async () => {
    const fake = buildOctokit({
      issue: { title: "Already opened", body: "..." },
      existingBackLinkBody: "Opened draft PR #44 ...\n\n<!-- bot:open-pr:44 -->",
    });
    const callLlm = mock(() => Promise.reject(new Error("classifier must not run")));
    const createBranchAndPr = mock(() => Promise.reject(new Error("must not be called")));
    const out = await runOpenPr({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 14,
      callLlm,
      createBranchAndPr,
    });
    if (out.kind !== "duplicate") throw new Error("expected duplicate");
    expect(out.existing_marker_comment_id).toBe(5050);
    expect(callLlm).not.toHaveBeenCalled();
    expect(createBranchAndPr).not.toHaveBeenCalled();
  });

  it("surfaces a maintainer-facing error when classifier fails (FR-017)", async () => {
    const fake = buildOctokit({ issue: { title: "T", body: null } });
    const callLlm = mock(() => Promise.reject(new Error("bedrock 429")));
    const createBranchAndPr = mock(() => Promise.reject(new Error("must not be called")));
    const out = await runOpenPr({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 15,
      callLlm,
      createBranchAndPr,
    });
    if (out.kind !== "classifier-failed") throw new Error("expected classifier-failed");
    expect(out.error_message).toContain("bedrock 429");
    expect(createBranchAndPr).not.toHaveBeenCalled();
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("No PR opened");
  });

  it("treats null issue body as empty for the classifier", async () => {
    const fake = buildOctokit({ issue: { title: "x", body: null } });
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ actionable: true, kind: "feature", reason: "ok" })),
    );
    const createBranchAndPr = mock(() =>
      Promise.resolve({ pr_number: 200, branch_name: "b", pr_url: "u" }),
    );
    const out = await runOpenPr({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 16,
      callLlm,
      createBranchAndPr,
    });
    expect(out.kind).toBe("opened");
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).not.toContain("null");
  });
});
