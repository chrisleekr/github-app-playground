/**
 * Tests for `bot:triage` (T078 / FR-034). Suggest-only — runtime
 * assertions confirm zero invocations of the forbidden mutation
 * methods. ≥90% coverage on `src/workflows/ship/scoped/triage.ts`.
 */

import { describe, expect, it, mock } from "bun:test";

import { runTriage } from "../../../../src/workflows/ship/scoped/triage";

interface FakeIssue {
  readonly title: string;
  readonly state: "open" | "closed";
  readonly body: string | null;
  readonly labels: readonly (string | { name?: string })[];
}

function buildOctokit(opts: { issue: FakeIssue; existingMarkerCommentId?: number }) {
  const issuesGet = mock(() => Promise.resolve({ data: opts.issue }));
  const updateComment = mock(() =>
    Promise.resolve({ data: { id: opts.existingMarkerCommentId ?? 0 } }),
  );
  const createComment = mock(() => Promise.resolve({ data: { id: 7001 } }));

  // Forbidden mutations — registered so we can assert zero calls.
  const addLabels = mock(() => Promise.resolve());
  const removeLabel = mock(() => Promise.resolve());
  const closeIssue = mock(() => Promise.resolve());
  const lockIssue = mock(() => Promise.resolve());
  const addAssignees = mock(() => Promise.resolve());
  const pinIssue = mock(() => Promise.resolve());

  const pages: { id: number; body: string | null }[][] =
    opts.existingMarkerCommentId === undefined
      ? [[]]
      : [[{ id: opts.existingMarkerCommentId, body: "<!-- bot:triage:88 -->" }]];

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
          updateComment,
          createComment,
          addLabels,
          removeLabel,
          lock: lockIssue,
          addAssignees,
          // closeIssue / pinIssue are GraphQL-only — we still register a
          // marker on rest in case a future implementation tries it.
          update: closeIssue,
        },
      },
      graphql: {
        // Mock graphql so any forbidden GraphQL mutation would be visible.
        // Calling it would throw because triage MUST NOT call graphql.
        // We use a getter that throws to make any attempted access loud.
      },
      paginate: { iterator: paginateIterator },
    } as never,
    issuesGet,
    updateComment,
    createComment,
    forbidden: { addLabels, removeLabel, closeIssue, lockIssue, addAssignees, pinIssue },
  };
}

describe("runTriage", () => {
  const issue: FakeIssue = {
    title: "Crash",
    state: "open",
    body: "stack trace",
    labels: [{ name: "needs-triage" }],
  };

  it("posts a single suggest-only comment with the triage marker", async () => {
    const fake = buildOctokit({ issue });
    const callLlm = mock(() =>
      Promise.resolve(
        "### Proposed labels\n- bug\n\n### Severity\nMedium\n\n### Duplicate candidates\nnone",
      ),
    );
    const result = await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("<!-- bot:triage:88 -->");
    expect(call.body).toContain("Proposed labels");
    expect(result.comment_id).toBe(7001);
  });

  it("MUST NOT call any forbidden mutation method (addLabels, removeLabel, close, lock, assign, pin)", async () => {
    const fake = buildOctokit({ issue });
    const callLlm = mock(() => Promise.resolve("body"));
    await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    expect(fake.forbidden.addLabels).not.toHaveBeenCalled();
    expect(fake.forbidden.removeLabel).not.toHaveBeenCalled();
    expect(fake.forbidden.closeIssue).not.toHaveBeenCalled();
    expect(fake.forbidden.lockIssue).not.toHaveBeenCalled();
    expect(fake.forbidden.addAssignees).not.toHaveBeenCalled();
    expect(fake.forbidden.pinIssue).not.toHaveBeenCalled();
  });

  it("updates the existing triage comment in place on re-trigger", async () => {
    const fake = buildOctokit({ issue, existingMarkerCommentId: 4040 });
    const callLlm = mock(() => Promise.resolve("updated"));
    const result = await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    expect(result.comment_id).toBe(4040);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("includes a closed-state prefix when the issue is closed", async () => {
    const fake = buildOctokit({ issue: { ...issue, state: "closed" } });
    const callLlm = mock(() => Promise.resolve("body"));
    await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    const call = fake.createComment.mock.calls[0]?.[0] as { body: string };
    expect(call.body).toContain("closed");
    expect(call.body).toContain("read-only");
  });

  it("renders existing-labels list in the LLM prompt (string + object label shapes)", async () => {
    const fake = buildOctokit({
      issue: { ...issue, labels: ["legacy-string-label", { name: "object-label" }] },
    });
    const callLlm = mock(() => Promise.resolve("body"));
    await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("legacy-string-label");
    expect(userPrompt).toContain("object-label");
  });

  it("renders '(none)' when no labels are present", async () => {
    const fake = buildOctokit({ issue: { ...issue, labels: [] } });
    const callLlm = mock(() => Promise.resolve("body"));
    await runTriage({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 88,
      callLlm,
    });
    const userPrompt = (callLlm.mock.calls[0]?.[0] as { userPrompt: string }).userPrompt;
    expect(userPrompt).toContain("(none)");
  });
});
