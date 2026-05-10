/**
 * Unit tests for the daemon-side workflow-executor `incomplete` branch
 * introduced for issue #93.
 *
 * Mocks the runs-store, tracking-mirror, orchestrator cascade, octokit, and
 * the registry handler so the test asserts only the executor's own dispatch
 * logic: did it call `markIncomplete`, did it emit a `setState` mirror with
 * the supplied `humanMessage`, and did it send a `job:result` envelope with
 * `success: false` and an `incomplete:`-prefixed `errorMessage`.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const markIncomplete = mock(async () => Promise.resolve());
const markFailed = mock(async () => Promise.resolve());
const markSucceeded = mock(async () => Promise.resolve());
const markRunning = mock(async () => Promise.resolve());
const mergeState = mock(async () => Promise.resolve());

void mock.module("../../src/workflows/runs-store", () => ({
  markIncomplete,
  markFailed,
  markSucceeded,
  markRunning,
  mergeState,
  findById: mock(async () => Promise.resolve(null)),
  findInflightByOwner: mock(async () => Promise.resolve([])),
  findLatestForTarget: mock(async () => Promise.resolve(null)),
  findLatestSucceededForTarget: mock(async () => Promise.resolve(null)),
  insertQueued: mock(async () => Promise.resolve()),
  listChildrenByParent: mock(async () => Promise.resolve([])),
  tryReserveTrackingCommentId: mock(async () =>
    Promise.resolve({ won: true, trackingCommentId: 0 }),
  ),
}));

const setStateMirror = mock(async () => Promise.resolve());
void mock.module("../../src/workflows/tracking-mirror", () => ({
  setState: setStateMirror,
  postRefusalComment: mock(() => Promise.resolve()),
}));

const onStepComplete = mock(async () => Promise.resolve());
void mock.module("../../src/workflows/orchestrator", () => ({
  onStepComplete,
}));

const handlerMock = mock();
void mock.module("../../src/workflows/registry", () => ({
  getByName: () => ({
    name: "resolve",
    label: "bot:resolve",
    handler: handlerMock,
  }),
}));

void mock.module("octokit", () => ({
  Octokit: function MockOctokit(this: unknown) {
    return this;
  },
}));

void mock.module("../../src/utils/reactions", () => ({
  addReaction: mock(() => Promise.resolve()),
}));

void mock.module("../../src/daemon/daemon-id", () => ({
  getDaemonId: () => "daemon-test",
}));

const { executeWorkflowRun } = await import("../../src/daemon/workflow-executor");

interface JobPayload {
  id: string;
  timestamp: number;
  payload: {
    context: Record<string, unknown>;
    installationToken: string;
    allowedTools: string[];
    workflowRun: {
      runId: string;
      workflowName: "resolve";
      parentRunId?: string;
      parentStepIndex?: number;
    };
  };
}

function buildPayload(): JobPayload {
  return {
    id: "offer-1",
    timestamp: Date.now(),
    payload: {
      context: {
        owner: "acme",
        repo: "widgets",
        entityNumber: 42,
        isPR: true,
        eventName: "pull_request",
        commentId: 0,
        deliveryId: "delivery-1",
      },
      installationToken: "tok",
      allowedTools: [],
      workflowRun: {
        runId: "run-incomplete",
        workflowName: "resolve",
      },
    },
  };
}

describe("executeWorkflowRun: incomplete branch", () => {
  beforeEach(() => {
    markIncomplete.mockClear();
    markFailed.mockClear();
    markSucceeded.mockClear();
    setStateMirror.mockClear();
    onStepComplete.mockClear();
    handlerMock.mockReset();
  });

  it("persists incomplete status, mirrors human message, and sends success=false envelope", async () => {
    handlerMock.mockResolvedValueOnce({
      status: "incomplete",
      reason: "CI still red after FIX_ATTEMPTS_CAP=3",
      state: { post_pipeline: { all_green: false } },
      humanMessage: "🔎 **Resolve incomplete**, typecheck still failing",
    });

    const sent: unknown[] = [];
    await executeWorkflowRun(buildPayload() as never, (msg) => {
      sent.push(msg);
    });

    expect(markIncomplete).toHaveBeenCalledTimes(1);
    const [runId, reason, state] = markIncomplete.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(runId).toBe("run-incomplete");
    expect(reason).toContain("CI still red");
    expect(state["post_pipeline"]).toBeDefined();

    expect(markFailed).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();

    expect(setStateMirror).toHaveBeenCalledTimes(1);
    const mirrorArgs = setStateMirror.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string },
    ];
    expect(mirrorArgs[1].humanMessage).toContain("Resolve incomplete");

    // job:result envelope must be a non-success with an `incomplete:` prefix
    // so the orchestrator cascade's failed-branch can detect it.
    const result = sent.find(
      (m): m is { type: string; payload: { success: boolean; errorMessage?: string } } =>
        typeof m === "object" &&
        m !== null &&
        "type" in m &&
        (m as { type: string }).type === "job:result",
    );
    expect(result).toBeDefined();
    expect(result?.payload.success).toBe(false);
    expect(result?.payload.errorMessage).toContain("incomplete:");

    // Cascade must be invoked once with status=failed (binary contract).
    expect(onStepComplete).toHaveBeenCalledTimes(1);
    const cascadeArgs = onStepComplete.mock.calls[0] as unknown as [
      unknown,
      string,
      { status: string; reason: string },
    ];
    expect(cascadeArgs[1]).toBe("run-incomplete");
    expect(cascadeArgs[2].status).toBe("failed");
    expect(cascadeArgs[2].reason).toContain("incomplete:");
  });

  it("falls back to a generic mirror message when humanMessage is omitted", async () => {
    handlerMock.mockResolvedValueOnce({
      status: "incomplete",
      reason: "outstanding section non-empty",
    });

    const sent: unknown[] = [];
    await executeWorkflowRun(buildPayload() as never, (msg) => {
      sent.push(msg);
    });

    expect(markIncomplete).toHaveBeenCalledTimes(1);
    expect(setStateMirror).toHaveBeenCalledTimes(1);
    const mirrorArgs = setStateMirror.mock.calls[0] as unknown as [
      unknown,
      { humanMessage: string },
    ];
    expect(mirrorArgs[1].humanMessage).toContain("incomplete");
  });
});
