/**
 * Tests for the marker-comment helper used by every scoped command
 * that posts an idempotent marker comment (T075/T077/T078/T079).
 * Coverage gate ≥90% lines + functions per bunfig.toml.
 */

import { describe, expect, it, mock } from "bun:test";

import {
  buildScopedMarker,
  findCommentByMarker,
  upsertMarkerComment,
} from "../../../../src/workflows/ship/scoped/marker-comment";
import { makeSilentLogger } from "../../../factories";

interface FakeComment {
  readonly id: number;
  readonly body: string | null;
}

function buildFakeOctokit(pages: readonly (readonly FakeComment[])[]) {
  const updateComment = mock(() => Promise.resolve({ data: { id: 0 } }));
  const createComment = mock(() => Promise.resolve({ data: { id: 999_001 } }));
  const listComments = mock(() => Promise.resolve({ data: pages[0] ?? [] }));

  const paginateIterator = mock(() => ({
    [Symbol.asyncIterator](): AsyncIterableIterator<{ data: readonly FakeComment[] }> {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<{ data: readonly FakeComment[] }>> =>
          Promise.resolve(
            i < pages.length
              ? { value: { data: pages[i++] ?? [] }, done: false }
              : { value: undefined, done: true },
          ),
        [Symbol.asyncIterator]() {
          return this;
        },
        return: (): Promise<IteratorResult<{ data: readonly FakeComment[] }>> =>
          Promise.resolve({ value: undefined, done: true }),
        throw: (e?: unknown): Promise<IteratorResult<{ data: readonly FakeComment[] }>> =>
          Promise.reject(e instanceof Error ? e : new Error(String(e))),
      };
    },
  }));

  return {
    octokit: {
      rest: {
        issues: {
          listComments,
          updateComment,
          createComment,
        },
      },
      paginate: { iterator: paginateIterator },
    } as never,
    listComments,
    updateComment,
    createComment,
    paginateIterator,
  };
}

describe("buildScopedMarker", () => {
  it("formats verb and number into the canonical marker shape", () => {
    expect(buildScopedMarker({ verb: "summarize", number: 42 })).toBe("<!-- bot:summarize:42 -->");
    expect(buildScopedMarker({ verb: "investigate", number: 7 })).toBe(
      "<!-- bot:investigate:7 -->",
    );
  });
});

describe("findCommentByMarker", () => {
  it("returns the comment id when a single page contains the marker", async () => {
    const marker = "<!-- bot:summarize:1 -->";
    const fake = buildFakeOctokit([
      [
        { id: 100, body: "first comment, no marker" },
        { id: 101, body: `second\n\n${marker}\n` },
      ],
    ]);
    const id = await findCommentByMarker({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 1,
      marker,
    });
    expect(id).toBe(101);
  });

  it("walks subsequent pages until the marker is found", async () => {
    const marker = "<!-- bot:investigate:9 -->";
    const fake = buildFakeOctokit([
      [{ id: 200, body: "no marker here" }],
      [{ id: 201, body: "still no marker" }],
      [{ id: 202, body: `tagged\n${marker}` }],
    ]);
    const id = await findCommentByMarker({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 9,
      marker,
    });
    expect(id).toBe(202);
  });

  it("returns null when no comment carries the marker", async () => {
    const fake = buildFakeOctokit([[{ id: 300, body: "unrelated" }], []]);
    const id = await findCommentByMarker({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 5,
      marker: "<!-- bot:triage:5 -->",
    });
    expect(id).toBeNull();
  });

  it("treats null/missing comment body as absence of the marker", async () => {
    const fake = buildFakeOctokit([[{ id: 400, body: null }]]);
    const id = await findCommentByMarker({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 3,
      marker: "<!-- bot:summarize:3 -->",
    });
    expect(id).toBeNull();
  });
});

describe("upsertMarkerComment", () => {
  it("creates a new comment when no marker is found", async () => {
    const marker = "<!-- bot:summarize:11 -->";
    const fake = buildFakeOctokit([[]]);
    const id = await upsertMarkerComment({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 11,
      marker,
      body: `body\n${marker}`,
      source: "system",
      log: makeSilentLogger(),
    });
    expect(id).toBe(999_001);
    expect(fake.createComment).toHaveBeenCalledTimes(1);
    expect(fake.updateComment).not.toHaveBeenCalled();
  });

  it("updates the existing comment in place when a marker is found", async () => {
    const marker = "<!-- bot:summarize:12 -->";
    const fake = buildFakeOctokit([
      [
        { id: 500, body: "noise" },
        { id: 501, body: `prior summary\n${marker}` },
      ],
    ]);
    const id = await upsertMarkerComment({
      octokit: fake.octokit,
      owner: "o",
      repo: "r",
      issue_number: 12,
      marker,
      body: `updated summary\n${marker}`,
      source: "system",
      log: makeSilentLogger(),
    });
    expect(id).toBe(501);
    expect(fake.updateComment).toHaveBeenCalledTimes(1);
    expect(fake.createComment).not.toHaveBeenCalled();
  });
});
