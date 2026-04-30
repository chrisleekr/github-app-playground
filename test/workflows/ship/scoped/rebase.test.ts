/**
 * Tests for `bot:rebase` (T076 / FR-032). ≥90% coverage on
 * `src/workflows/ship/scoped/rebase.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { runRebase } from "../../../../src/workflows/ship/scoped/rebase";

function buildOctokit(opts: {
  pr: { state: "open" | "closed"; merged?: boolean; base_ref: string; head_ref: string };
}) {
  const get = mock(() =>
    Promise.resolve({
      data: {
        state: opts.pr.state,
        merged: opts.pr.merged === true,
        base: { ref: opts.pr.base_ref },
        head: { ref: opts.pr.head_ref },
      },
    }),
  );
  const createComment = mock(() =>
    Promise.resolve({ data: { id: Math.floor(Math.random() * 100_000) + 1 } }),
  );
  return {
    octokit: {
      rest: {
        pulls: { get },
        issues: { createComment },
      },
    } as never,
    get,
    createComment,
  };
}

describe("runRebase", () => {
  it("returns up-to-date when the merge is a no-op", async () => {
    const fake = buildOctokit({
      pr: { state: "open", base_ref: "main", head_ref: "feature" },
    });
    const runMerge = mock(() => Promise.resolve({ status: "up-to-date" as const }));
    const out = await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    expect(out.kind).toBe("up-to-date");
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("Already up to date");
  });

  it("returns merged with the merge commit SHA on a successful fast-forward merge", async () => {
    const fake = buildOctokit({
      pr: { state: "open", base_ref: "main", head_ref: "feature" },
    });
    const runMerge = mock(() =>
      Promise.resolve({ status: "merged" as const, merge_commit_sha: "fa1afe1" }),
    );
    const out = await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    if (out.kind !== "merged") throw new Error("expected merged outcome");
    expect(out.merge_commit_sha).toBe("fa1afe1");
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("no force-push");
    expect(body).toContain("fa1afe1");
  });

  it("returns conflict with the conflicting paths and does NOT push", async () => {
    const fake = buildOctokit({
      pr: { state: "open", base_ref: "main", head_ref: "feature" },
    });
    const runMerge = mock(() =>
      Promise.resolve({
        status: "conflict" as const,
        conflict_paths: ["src/a.ts", "src/b.ts"],
      }),
    );
    const out = await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    if (out.kind !== "conflict") throw new Error("expected conflict outcome");
    expect(out.conflict_paths).toEqual(["src/a.ts", "src/b.ts"]);
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("src/a.ts");
    expect(body).toContain("src/b.ts");
    expect(body).toContain("haven't pushed");
  });

  it("renders '(none)' for an empty conflict list", async () => {
    const fake = buildOctokit({
      pr: { state: "open", base_ref: "main", head_ref: "feature" },
    });
    const runMerge = mock(() => Promise.resolve({ status: "conflict" as const }));
    await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("(none)");
  });

  it("refuses to rebase a closed PR", async () => {
    const fake = buildOctokit({
      pr: { state: "closed", base_ref: "main", head_ref: "f" },
    });
    const runMerge = mock(() => Promise.resolve({ status: "up-to-date" as const }));
    const out = await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    expect(out.kind).toBe("closed");
    expect(runMerge).not.toHaveBeenCalled();
  });

  it("refuses to rebase a merged PR (state=closed + merged=true)", async () => {
    const fake = buildOctokit({
      pr: { state: "closed", merged: true, base_ref: "main", head_ref: "f" },
    });
    const runMerge = mock(() => Promise.resolve({ status: "up-to-date" as const }));
    const out = await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    expect(out.kind).toBe("closed");
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("merged");
  });

  it("renders '(unknown)' when merge succeeds without a SHA", async () => {
    const fake = buildOctokit({
      pr: { state: "open", base_ref: "main", head_ref: "f" },
    });
    const runMerge = mock(() => Promise.resolve({ status: "merged" as const }));
    await runRebase({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      pr_number: 5,
      runMerge,
    });
    const body = (fake.createComment.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("(unknown)");
  });
});
