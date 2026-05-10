/**
 * Unit tests for enforceSingleBotLabel.
 *
 * Octokit is stubbed: the function's only side effects are three REST calls,
 * and we assert exactly which are made.
 */

import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import { enforceSingleBotLabel } from "../../src/workflows/label-mutex";

const silentLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(function () {
    return this;
  }),
} as never;

interface StubOctokitOpts {
  labelsOnIssue: { name: string }[];
  removeLabelFails?: Set<string>;
}

function stubOctokit(opts: StubOctokitOpts): {
  octokit: Octokit;
  removeLabel: ReturnType<typeof mock>;
  listLabels: ReturnType<typeof mock>;
} {
  const listLabels = mock(async () => Promise.resolve({ data: opts.labelsOnIssue }));
  const removeLabel = mock(async (args: { name: string }) => {
    if (opts.removeLabelFails?.has(args.name) === true) {
      throw new Error(`cannot remove ${args.name}`);
    }
    return Promise.resolve({ data: {} });
  });

  return {
    octokit: {
      rest: {
        issues: {
          listLabelsOnIssue: listLabels,
          removeLabel,
        },
      },
    } as unknown as Octokit,
    removeLabel,
    listLabels,
  };
}

describe("enforceSingleBotLabel", () => {
  it("removes every other bot:* label and keeps the one just applied", async () => {
    const { octokit, removeLabel } = stubOctokit({
      labelsOnIssue: [
        { name: "bot:plan" },
        { name: "bot:ship" },
        { name: "bug" },
        { name: "good first issue" },
      ],
    });

    const result = await enforceSingleBotLabel({
      octokit,
      owner: "acme",
      repo: "repo",
      number: 42,
      justApplied: "bot:ship",
      logger: silentLog,
    });

    expect(result.kept).toBe("bot:ship");
    expect(result.removed.sort()).toEqual(["bot:plan"]);
    expect(removeLabel).toHaveBeenCalledTimes(1);
    const call = removeLabel.mock.calls[0] as unknown as [{ name: string }];
    expect(call[0]?.name).toBe("bot:plan");
  });

  it("is a no-op when no sibling bot:* labels are present", async () => {
    const { octokit, removeLabel } = stubOctokit({
      labelsOnIssue: [{ name: "bot:triage" }, { name: "bug" }],
    });

    const result = await enforceSingleBotLabel({
      octokit,
      owner: "acme",
      repo: "repo",
      number: 1,
      justApplied: "bot:triage",
      logger: silentLog,
    });

    expect(result.removed).toEqual([]);
    expect(removeLabel).not.toHaveBeenCalled();
  });

  it("does not touch non-bot labels", async () => {
    const { octokit, removeLabel } = stubOctokit({
      labelsOnIssue: [{ name: "area: backend" }, { name: "priority: high" }, { name: "bot:plan" }],
    });

    await enforceSingleBotLabel({
      octokit,
      owner: "acme",
      repo: "repo",
      number: 1,
      justApplied: "bot:ship",
      logger: silentLog,
    });

    expect(removeLabel).toHaveBeenCalledTimes(1);
    const call = removeLabel.mock.calls[0] as unknown as [{ name: string }];
    expect(call[0]?.name).toBe("bot:plan");
  });

  it("continues after a per-label removal error and reports only successes", async () => {
    const { octokit, removeLabel } = stubOctokit({
      labelsOnIssue: [{ name: "bot:plan" }, { name: "bot:triage" }],
      removeLabelFails: new Set(["bot:plan"]),
    });

    const result = await enforceSingleBotLabel({
      octokit,
      owner: "acme",
      repo: "repo",
      number: 1,
      justApplied: "bot:ship",
      logger: silentLog,
    });

    expect(removeLabel).toHaveBeenCalledTimes(2);
    expect(result.removed).toEqual(["bot:triage"]);
  });
});
