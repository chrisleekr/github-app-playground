/**
 * Integration tests for the composite-workflow hand-off orchestrator (T025, T026).
 *
 * Covers the `contracts/handoff-protocol.md` per-step cascade:
 *   - Success chain: parent + child 0 succeed → child 1 enqueued → … → on
 *     child-3 (resolve) success, parent flips to `succeeded` with the full
 *     `state.stepRuns` ordering.
 *   - Failure cascade: child-2 (implement) fails → parent flips to `failed`
 *     with `state.failedAtStepIndex=2` → no child 3 is enqueued.
 *
 * The test owns a real Postgres connection (Bun's `SQL`) because the
 * orchestrator's cascade logic lives entirely inside `db.begin()` and the
 * `SELECT … FOR UPDATE` lock cannot be meaningfully faked. Downstream
 * surfaces that escape the transaction (`job-queue`, `tracking-mirror`) are
 * mocked so the assertions stay deterministic and do not hit Valkey/GitHub.
 */

import { SQL } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type pino from "pino";

const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgres://bot:bot@localhost:5432/github_app_test";

let sql: SQL | null = null;
try {
  const conn = new SQL(TEST_DATABASE_URL);
  await conn`SELECT 1 AS ok`;
  sql = conn;
} catch {
  sql = null;
}

function requireSql(): SQL {
  if (sql === null) throw new Error("Database not available — test should have been skipped");
  return sql;
}

// ─── Mocked downstream surfaces ──────────────────────────────────────────

const mockEnqueueJob = mock(() => Promise.resolve());
void mock.module("../../src/orchestrator/job-queue", () => ({
  enqueueJob: mockEnqueueJob,
}));

void mock.module("../../src/workflows/execution-row", () => ({
  recordWorkflowExecution: mock(() => Promise.resolve()),
  buildWorkflowContextJson: mock(() => ({})),
}));

void mock.module("../../src/orchestrator/concurrency", () => ({
  incrementActiveCount: mock(() => {}),
  decrementActiveCount: mock(() => {}),
}));

const mockSetState = mock(() => Promise.resolve());
void mock.module("../../src/workflows/tracking-mirror", () => ({
  setState: mockSetState,
  postRefusalComment: mock(() => Promise.resolve()),
}));

// Point requireDb() at our test SQL so the orchestrator's `db.begin()`
// runs against the integration database rather than opening a new pool
// from config.databaseUrl.
void mock.module("../../src/db", () => ({
  requireDb: () => requireSql(),
  getDb: () => requireSql(),
  closeDb: () => Promise.resolve(),
}));

function silentLogger(): pino.Logger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function (this: unknown) {
      return this;
    }),
  } as unknown as pino.Logger;
}

const target = { type: "issue" as const, owner: "acme", repo: "repo", number: 200 };

describe.skipIf(sql === null)("orchestrator.onStepComplete", () => {
  beforeAll(async () => {
    await requireSql().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    const { runMigrations } = await import("../../src/db/migrate");
    await runMigrations(requireSql());
  });

  afterAll(async () => {
    await requireSql().unsafe(`
      DROP TABLE IF EXISTS _migrations CASCADE;
      DROP TABLE IF EXISTS workflow_runs CASCADE;
      DROP TABLE IF EXISTS repo_memory CASCADE;
      DROP TABLE IF EXISTS triage_results CASCADE;
      DROP TABLE IF EXISTS executions CASCADE;
      DROP TABLE IF EXISTS daemons CASCADE;
    `);
    await requireSql().close();
  });

  beforeEach(() => {
    mockEnqueueJob.mockClear();
    mockSetState.mockClear();
  });

  it("T025 success chain: each child success enqueues the next, final child flips parent to succeeded", async () => {
    const { insertQueued, findById, markRunning, markSucceeded } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 201;
    const shipTarget = { ...target, number: issueNumber };

    // Seed: parent ship + first child (triage@0). The executor flips the
    // parent to `running` before invoking the ship handler — replicate
    // that here so status expectations match production behaviour.
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());
    const child0 = await insertQueued(
      {
        workflowName: "triage",
        target: shipTarget,
        parentRunId: parent.id,
        parentStepIndex: 0,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    // ── child 0 (triage) succeeds ────────────────────────────────────────
    // Simulate the executor's terminal write before the cascade runs, so
    // the orchestrator sees the child as already succeeded.
    await markSucceeded(child0.id, { verdict: "valid" }, requireSql());

    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child0.id, {
      status: "succeeded",
    });

    // Parent should now reference the new plan child at index 1.
    let parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("running");
    expect(parentRow?.state["currentStepIndex"]).toBe(1);
    expect(parentRow?.state["stepRuns"]).toEqual([child0.id]);

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    const call0 = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call0?.workflowRun.workflowName).toBe("plan");
    expect(call0?.workflowRun.parentStepIndex).toBe(1);
    const child1RunId = call0?.workflowRun.runId ?? "";
    expect(child1RunId).not.toBe("");

    // ── child 1 (plan) succeeds ──────────────────────────────────────────
    await markSucceeded(child1RunId, { planWritten: true }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child1RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.state["currentStepIndex"]).toBe(2);
    expect(parentRow?.state["stepRuns"]).toEqual([child0.id, child1RunId]);

    const call1 = mockEnqueueJob.mock.calls[1]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call1?.workflowRun.workflowName).toBe("implement");
    expect(call1?.workflowRun.parentStepIndex).toBe(2);
    const child2RunId = call1?.workflowRun.runId ?? "";

    // ── child 2 (implement) succeeds ─────────────────────────────────────
    await markSucceeded(child2RunId, { pr_number: 42 }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child2RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.state["currentStepIndex"]).toBe(3);

    const call2 = mockEnqueueJob.mock.calls[2]?.[0] as
      | { workflowRun: { workflowName: string; parentStepIndex: number; runId: string } }
      | undefined;
    expect(call2?.workflowRun.workflowName).toBe("resolve");
    expect(call2?.workflowRun.parentStepIndex).toBe(3);
    const child3RunId = call2?.workflowRun.runId ?? "";

    // ── child 3 (resolve) succeeds → parent flips to succeeded ────────────
    await markSucceeded(child3RunId, { approved: true }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child3RunId, {
      status: "succeeded",
    });

    parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("succeeded");
    expect(parentRow?.state["currentStepIndex"]).toBe(4);
    expect(parentRow?.state["stepRuns"]).toEqual([
      child0.id,
      child1RunId,
      child2RunId,
      child3RunId,
    ]);

    // Final call is a terminal tracking emit, not an enqueue — enqueue
    // count is still 3 (one per non-terminal transition).
    expect(mockEnqueueJob).toHaveBeenCalledTimes(3);
    expect(mockSetState).toHaveBeenCalled();
  });

  it("T026 failure cascade: child-2 failure flips parent to failed with failedAtStepIndex=2, no further children", async () => {
    const { insertQueued, findById, markRunning, markSucceeded, markFailed, listChildrenByParent } =
      await import("../../src/workflows/runs-store");
    const { onStepComplete } = await import("../../src/workflows/orchestrator");

    const issueNumber = 202;
    const shipTarget = { ...target, number: issueNumber };

    // Seed parent + first child, then walk two successful step completions
    // so the cascade naturally reaches step index 2.
    const parent = await insertQueued(
      {
        workflowName: "ship",
        target: shipTarget,
        initialState: { currentStepIndex: 0, stepRuns: [] },
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );
    await markRunning(parent.id, "test-daemon", requireSql());
    const child0 = await insertQueued(
      {
        workflowName: "triage",
        target: shipTarget,
        parentRunId: parent.id,
        parentStepIndex: 0,
        ownerKind: "orchestrator",
        ownerId: "test-orchestrator",
      },
      requireSql(),
    );

    await markSucceeded(child0.id, { verdict: "valid" }, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child0.id, {
      status: "succeeded",
    });

    const child1Enqueue = mockEnqueueJob.mock.calls[0]?.[0] as
      | { workflowRun: { runId: string } }
      | undefined;
    const child1RunId = child1Enqueue?.workflowRun.runId ?? "";
    await markSucceeded(child1RunId, {}, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child1RunId, {
      status: "succeeded",
    });

    const child2Enqueue = mockEnqueueJob.mock.calls[1]?.[0] as
      | { workflowRun: { runId: string; workflowName: string; parentStepIndex: number } }
      | undefined;
    expect(child2Enqueue?.workflowRun.workflowName).toBe("implement");
    const child2RunId = child2Enqueue?.workflowRun.runId ?? "";

    mockEnqueueJob.mockClear();

    // ── child 2 (implement) FAILS ────────────────────────────────────────
    await markFailed(child2RunId, "merge conflict", {}, requireSql());
    await onStepComplete({ octokit: {} as never, logger: silentLogger() }, child2RunId, {
      status: "failed",
      reason: "merge conflict",
    });

    const parentRow = await findById(parent.id, requireSql());
    expect(parentRow?.status).toBe("failed");
    expect(parentRow?.state["failedAtStepIndex"]).toBe(2);
    expect(parentRow?.state["failedReason"]).toBe("merge conflict");

    // No new child row was inserted after the failure.
    const children = await listChildrenByParent(parent.id, requireSql());
    expect(children.map((c) => c.parent_step_index)).toEqual([0, 1, 2]);
    expect(mockEnqueueJob).not.toHaveBeenCalled();

    // Terminal tracking emit fired for the parent's failed transition.
    expect(mockSetState).toHaveBeenCalled();
  });
});
