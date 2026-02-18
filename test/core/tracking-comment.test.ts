import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import {
  createTrackingComment,
  deliveryMarker,
  finalizeTrackingComment,
  isAlreadyProcessed,
  updateTrackingComment,
} from "../../src/core/tracking-comment";
import type { BotContext } from "../../src/types";

/** Minimal silent logger */
const silentLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  child: mock(function () {
    return this;
  }),
} as never;

function makeCtx(overrides?: Partial<BotContext>): BotContext {
  return {
    owner: "myorg",
    repo: "myrepo",
    entityNumber: 42,
    isPR: false,
    eventName: "issue_comment" as const,
    triggerUsername: "tester",
    triggerTimestamp: "2025-01-01T00:00:00Z",
    triggerBody: "@chrisleekr-bot help",
    commentId: 1,
    deliveryId: "del-abc-123",
    defaultBranch: "main",
    octokit: {} as Octokit,
    log: silentLog,
    ...overrides,
  };
}

// ─── deliveryMarker ───────────────────────────────────────────────────────────

describe("deliveryMarker", () => {
  it("returns an HTML comment with the delivery ID", () => {
    expect(deliveryMarker("abc-123")).toBe("<!-- delivery:abc-123 -->");
  });
});

// ─── isAlreadyProcessed ───────────────────────────────────────────────────────

describe("isAlreadyProcessed", () => {
  it("returns true when the delivery marker is found in comments", async () => {
    const ctx = makeCtx();
    ctx.octokit = {
      rest: {
        issues: {
          listComments: mock(() =>
            Promise.resolve({
              data: [
                { body: `<!-- delivery:del-abc-123 -->\nWorking...` },
                { body: "Some other comment" },
              ],
            }),
          ),
        },
      },
    } as unknown as Octokit;

    const result = await isAlreadyProcessed(ctx);
    expect(result).toBe(true);
  });

  it("calls listComments with direction:desc and per_page:100", async () => {
    const ctx = makeCtx();
    const listComments = mock(() => Promise.resolve({ data: [] }));
    ctx.octokit = { rest: { issues: { listComments } } } as unknown as Octokit;

    await isAlreadyProcessed(ctx);

    // listComments was called once; the non-null cast is safe.

    const callArgs = (listComments.mock.calls[0] as [Record<string, unknown>])[0];
    expect(callArgs["direction"]).toBe("desc");
    expect(callArgs["per_page"]).toBe(100);
  });

  it("returns false when no comment contains the delivery marker", async () => {
    const ctx = makeCtx();
    ctx.octokit = {
      rest: {
        issues: {
          listComments: mock(() =>
            Promise.resolve({
              data: [
                { body: "<!-- delivery:different-id -->\nWorking..." },
                { body: "Normal comment" },
              ],
            }),
          ),
        },
      },
    } as unknown as Octokit;

    const result = await isAlreadyProcessed(ctx);
    expect(result).toBe(false);
  });

  it("returns false when comment list is empty", async () => {
    const ctx = makeCtx();
    ctx.octokit = {
      rest: { issues: { listComments: mock(() => Promise.resolve({ data: [] })) } },
    } as unknown as Octokit;

    expect(await isAlreadyProcessed(ctx)).toBe(false);
  });

  it("returns false for a comment with undefined body", async () => {
    const ctx = makeCtx();
    ctx.octokit = {
      rest: {
        issues: { listComments: mock(() => Promise.resolve({ data: [{ body: undefined }] })) },
      },
    } as unknown as Octokit;

    expect(await isAlreadyProcessed(ctx)).toBe(false);
  });
});

// ─── createTrackingComment ────────────────────────────────────────────────────

describe("createTrackingComment", () => {
  it("creates a comment containing the delivery marker and returns the comment ID", async () => {
    const ctx = makeCtx();
    let capturedBody = "";
    ctx.octokit = {
      rest: {
        issues: {
          createComment: mock(({ body }: { body: string }) => {
            capturedBody = body;
            return Promise.resolve({ data: { id: 999 } });
          }),
        },
      },
    } as unknown as Octokit;

    const id = await createTrackingComment(ctx);

    expect(id).toBe(999);
    expect(capturedBody).toContain("<!-- delivery:del-abc-123 -->");
    expect(capturedBody).toContain("@chrisleekr-bot");
  });
});

// ─── updateTrackingComment ────────────────────────────────────────────────────

describe("updateTrackingComment", () => {
  it("calls updateComment with the provided body", async () => {
    const ctx = makeCtx();
    let capturedArgs: Record<string, unknown> = {};
    ctx.octokit = {
      rest: {
        issues: {
          updateComment: mock((args: Record<string, unknown>) => {
            capturedArgs = args;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;

    await updateTrackingComment(ctx, 1, "new body");

    expect(capturedArgs["owner"]).toBe("myorg");
    expect(capturedArgs["repo"]).toBe("myrepo");
    expect(capturedArgs["comment_id"]).toBe(1);
    expect(capturedArgs["body"]).toBe("new body");
  });
});

// ─── finalizeTrackingComment ──────────────────────────────────────────────────

describe("finalizeTrackingComment", () => {
  let capturedUpdateBody = "";
  let ctx: BotContext;

  beforeEach(() => {
    capturedUpdateBody = "";
    ctx = makeCtx();
    ctx.octokit = {
      rest: {
        issues: {
          getComment: mock(() =>
            Promise.resolve({
              data: { body: "<!-- delivery:del-abc-123 -->\n**Working...**" },
            }),
          ),
          updateComment: mock(({ body }: { body: string }) => {
            capturedUpdateBody = body;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;
  });

  it("success path: final body contains the success header with duration and cost", async () => {
    await finalizeTrackingComment(ctx, 1, {
      success: true,
      durationMs: 5000,
      costUsd: 0.0123,
    });

    expect(capturedUpdateBody).toContain("finished");
    expect(capturedUpdateBody).toContain("5.0s");
    expect(capturedUpdateBody).toContain("$0.0123");
  });

  it("success path: re-prepends the delivery marker", async () => {
    await finalizeTrackingComment(ctx, 1, { success: true });

    expect(capturedUpdateBody.startsWith("<!-- delivery:del-abc-123 -->")).toBe(true);
  });

  it("error path: final body contains the error section", async () => {
    await finalizeTrackingComment(ctx, 1, {
      success: false,
      error: "An internal error occurred. Check server logs for details.",
    });

    expect(capturedUpdateBody).toContain("encountered an error");
    expect(capturedUpdateBody).toContain(
      "An internal error occurred. Check server logs for details.",
    );
  });

  it("error path: re-prepends the delivery marker", async () => {
    await finalizeTrackingComment(ctx, 1, { success: false });

    expect(capturedUpdateBody.startsWith("<!-- delivery:del-abc-123 -->")).toBe(true);
  });

  it("falls back gracefully when getComment throws, still calls updateComment", async () => {
    let updateCalled = false;
    ctx.octokit = {
      rest: {
        issues: {
          getComment: mock(() => Promise.reject(new Error("network error"))),
          updateComment: mock(() => {
            updateCalled = true;
            return Promise.resolve({ data: { id: 1 } });
          }),
        },
      },
    } as unknown as Octokit;

    await finalizeTrackingComment(ctx, 1, { success: true });

    expect(updateCalled).toBe(true);
  });
});
