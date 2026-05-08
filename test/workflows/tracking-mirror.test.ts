import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";
import pino from "pino";

import type { WorkflowRunRow } from "../../src/workflows/runs-store";

// Mock the runs-store DB layer so the tracking-mirror exercises pure logic
// without touching Postgres. Each test seeds the mocks via the exported
// `setMockRow` / `setMockReservation` helpers below.
let mockRow: WorkflowRunRow | null = null;
let mockReservation: { won: boolean; trackingCommentId: number } = {
  won: true,
  trackingCommentId: 0,
};
const mergeStateMock = mock(() => Promise.resolve());
const findByIdMock = mock(() => Promise.resolve(mockRow));
const tryReserveMock = mock(() => Promise.resolve(mockReservation));
const listChildrenByParentMock = mock(() => Promise.resolve([] as readonly WorkflowRunRow[]));

void mock.module("../../src/workflows/runs-store", () => ({
  findById: findByIdMock,
  listChildrenByParent: listChildrenByParentMock,
  mergeState: mergeStateMock,
  tryReserveTrackingCommentId: tryReserveMock,
}));

// Import AFTER mock.module so the module-under-test binds to mocks.
const { setState } = await import("../../src/workflows/tracking-mirror");

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const MARKER = `<!-- workflow-run:${RUN_ID} -->`;
const SILENT_LOGGER = pino({ level: "silent" });

function makeRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: RUN_ID,
    workflow_name: "plan",
    target_type: "issue",
    target_owner: "acme",
    target_repo: "widgets",
    target_number: 42,
    parent_run_id: null,
    parent_step_index: null,
    status: "running",
    state: {},
    tracking_comment_id: null,
    delivery_id: "del-1",
    owner_kind: "daemon",
    owner_id: "daemon-1",
    trigger_comment_id: null,
    trigger_event_type: null,
    created_at: new Date("2026-05-08T02:55:00Z"),
    updated_at: new Date("2026-05-08T02:55:00Z"),
    ...overrides,
  };
}

interface OctokitCallLog {
  createComment: ReturnType<typeof mock>;
  updateComment: ReturnType<typeof mock>;
  deleteComment: ReturnType<typeof mock>;
  listComments: ReturnType<typeof mock>;
}

function makeOctokit(opts: {
  listCommentsData?: { id: number; body: string; created_at: string }[];
  createCommentResult?: { id: number } | { throwError: Error };
}): { octokit: Octokit; calls: OctokitCallLog } {
  const listComments = mock(() => Promise.resolve({ data: opts.listCommentsData ?? [] }));
  const createComment = mock(() => {
    if (opts.createCommentResult && "throwError" in opts.createCommentResult) {
      return Promise.reject(opts.createCommentResult.throwError);
    }
    return Promise.resolve({ data: opts.createCommentResult ?? { id: 9000 } });
  });
  const updateComment = mock(() => Promise.resolve({ data: {} }));
  const deleteComment = mock(() => Promise.resolve({ data: {} }));
  const calls: OctokitCallLog = { createComment, updateComment, deleteComment, listComments };
  const octokit = {
    rest: { issues: { createComment, updateComment, deleteComment, listComments } },
  } as unknown as Octokit;
  return { octokit, calls };
}

describe("tracking-mirror.setState — first-touch create/adopt path", () => {
  beforeEach(() => {
    mergeStateMock.mockClear();
    findByIdMock.mockClear();
    tryReserveMock.mockClear();
    listChildrenByParentMock.mockClear();
  });

  it("creates a comment on the happy path when no marker exists yet", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 9000 };
    const { octokit, calls } = makeOctokit({
      createCommentResult: { id: 9000 },
    });

    // Pre-scan empty, post-scan reflects the just-created comment.
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(listComments).toHaveBeenCalledTimes(2); // pre + post
    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).not.toHaveBeenCalled();
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 9000);
    // Body sent to GitHub embeds the marker so future scans can find it.
    const createBody = (calls.createComment.mock.calls[0]?.[0] as { body: string } | undefined)
      ?.body;
    expect(createBody).toContain(MARKER);
    expect(result.tracking_comment_id).toBe(9000);
  });

  it("adopts an existing marker comment without POSTing when pre-scan finds one (pod-restart recovery)", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 7777 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [
        { id: 7777, body: `${MARKER}\nold body`, created_at: "2026-05-08T02:55:43Z" },
      ],
    });

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    // No new POST — orphan adopted.
    expect(calls.createComment).not.toHaveBeenCalled();
    expect(calls.updateComment).toHaveBeenCalledTimes(1); // refresh body on adopted comment
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 7777);
    expect(result.tracking_comment_id).toBe(7777);
  });

  it("reconciles octokit-internal retry duplicates: adopts oldest, deletes the rest", async () => {
    // Models the issue #109 failure mode: octokit's plugin-retry retried a
    // POST that had already committed server-side, producing N orphan comments.
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 1001 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [], // pre-scan empty
      createCommentResult: { id: 1004 }, // create returns the LAST retry's id
    });

    // After createComment, post-scan returns the four duplicates.
    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [
          { id: 1001, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:43Z" },
          { id: 1002, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:46Z" },
          { id: 1003, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:53Z" },
          { id: 1004, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:58:05Z" },
        ],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).toHaveBeenCalledTimes(3); // 4 dupes → keep oldest, delete 3
    const deletedIds = calls.deleteComment.mock.calls.map(
      (c) => (c[0] as { comment_id: number }).comment_id,
    );
    expect(deletedIds).toEqual([1002, 1003, 1004]);
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 1001);
    expect(result.tracking_comment_id).toBe(1001);
  });

  it("recovers when createComment throws but server actually committed (orphan from internal retry)", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 5555 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [],
      createCommentResult: { throwError: new Error("socket hang up") },
    });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 5555, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:57:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(calls.deleteComment).not.toHaveBeenCalled();
    expect(tryReserveMock).toHaveBeenCalledWith(RUN_ID, 5555);
    expect(result.tracking_comment_id).toBe(5555);
  });

  it("rethrows the createComment error when no marker is found server-side", async () => {
    mockRow = makeRow();
    mockReservation = { won: true, trackingCommentId: 0 };
    const { octokit, calls } = makeOctokit({
      listCommentsData: [], // both scans empty
      createCommentResult: { throwError: new Error("upstream 500") },
    });

    let thrown: unknown = null;
    try {
      await setState(
        { octokit, logger: SILENT_LOGGER },
        { runId: RUN_ID, patch: {}, humanMessage: "starting" },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("upstream 500");

    expect(calls.createComment).toHaveBeenCalledTimes(1);
    expect(tryReserveMock).not.toHaveBeenCalled();
  });

  it("scopes the listComments scan via since=row.created_at and per_page=100", async () => {
    mockRow = makeRow({ created_at: new Date("2026-05-08T02:55:00.000Z") });
    mockReservation = { won: true, trackingCommentId: 9000 };
    const { octokit } = makeOctokit({
      createCommentResult: { id: 9000 },
    });

    let scanCallCount = 0;
    const listComments = mock(() => {
      scanCallCount += 1;
      if (scanCallCount === 1) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [{ id: 9000, body: `${MARKER}\nstarting`, created_at: "2026-05-08T02:55:43Z" }],
      });
    });
    (octokit.rest.issues as unknown as { listComments: typeof listComments }).listComments =
      listComments;

    await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "starting" },
    );

    const args = listComments.mock.calls[0]?.[0] as
      | { owner: string; repo: string; issue_number: number; per_page: number; since: string }
      | undefined;
    expect(args?.since).toBe("2026-05-08T02:55:00.000Z");
    expect(args?.per_page).toBe(100);
    expect(args?.owner).toBe("acme");
    expect(args?.repo).toBe("widgets");
    expect(args?.issue_number).toBe(42);
  });

  it("updates the existing comment without POST when the row already has tracking_comment_id", async () => {
    mockRow = makeRow({ tracking_comment_id: 4242 });
    const { octokit, calls } = makeOctokit({});

    const result = await setState(
      { octokit, logger: SILENT_LOGGER },
      { runId: RUN_ID, patch: {}, humanMessage: "next message" },
    );

    expect(calls.createComment).not.toHaveBeenCalled();
    expect(calls.listComments).not.toHaveBeenCalled();
    expect(calls.updateComment).toHaveBeenCalledTimes(1);
    const updateArgs = calls.updateComment.mock.calls[0]?.[0] as
      | { comment_id: number; body: string }
      | undefined;
    expect(updateArgs?.comment_id).toBe(4242);
    expect(updateArgs?.body).toContain(MARKER);
    expect(result.tracking_comment_id).toBe(4242);
  });
});
