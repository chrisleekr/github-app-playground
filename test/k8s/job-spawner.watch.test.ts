/**
 * Tests for `watchJobCompletion` in src/k8s/job-spawner.ts — the
 * completion watcher that enforces T046 (wall-clock timeout),
 * T047 (releaseInFlight in finally), and T048 (FR-021 no retry on
 * mid-run failure).
 *
 * All tests inject the K8s client, sleep, now, markFailed, and
 * releaseInFlight so none of them touch the real K8s API, clock, or
 * Valkey.
 */

import { describe, expect, it, mock } from "bun:test";

// Silence logger — mock MUST be registered before `../../src/k8s/job-spawner`
// is imported, otherwise the real pino module is already in the module
// cache and the mock never takes effect. `await import(...)` below defers
// the spawner module load until after the mock is registered.
void mock.module("../../src/logger", () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    child: mock(function () {
      return this;
    }),
  },
}));

const { watchJobCompletion } = await import("../../src/k8s/job-spawner");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StatusResponse {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type?: string; reason?: string }[];
  };
}

function stubClient(opts: {
  statuses: StatusResponse[];
  throwOnRead?: () => unknown;
  deleteImpl?: () => Promise<void>;
}): {
  readNamespacedJobStatus: ReturnType<typeof mock>;
  deleteNamespacedJob: ReturnType<typeof mock>;
} {
  let i = 0;
  const read = mock(() => {
    if (opts.throwOnRead !== undefined) {
      throw opts.throwOnRead();
    }
    const s = opts.statuses[Math.min(i, opts.statuses.length - 1)] ?? {};
    i++;
    return Promise.resolve(s);
  });
  const del = mock(async () => {
    if (opts.deleteImpl !== undefined) await opts.deleteImpl();
  });
  return {
    readNamespacedJobStatus: read,
    deleteNamespacedJob: del,
  };
}

// Fast fake clock / sleep: sleep increments a counter by the requested ms
// and resolves immediately.
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watchJobCompletion — succeeded", () => {
  it("returns 'succeeded' when status.succeeded >= 1", async () => {
    const client = stubClient({ statuses: [{ status: { succeeded: 1 } }] });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-1", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("succeeded");
    expect(markFailed).not.toHaveBeenCalled();
    expect(client.deleteNamespacedJob).not.toHaveBeenCalled();
    // T047 invariant: releaseInFlight fires regardless of outcome.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("d-1");
  });
});

describe("watchJobCompletion — failed (T048 / FR-021)", () => {
  it("returns 'failed' on generic Pod failure, does NOT delete or mark timeout", async () => {
    const client = stubClient({ statuses: [{ status: { failed: 1 } }] });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-2", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("failed");
    // FR-021: no retry, no re-dispatch. Entrypoint owns the row on a
    // graceful failure — watcher must not stomp it with markFailed.
    expect(markFailed).not.toHaveBeenCalled();
    expect(client.deleteNamespacedJob).not.toHaveBeenCalled();
    // T047 invariant.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns 'timeout' (not 'failed') when the failure carries DeadlineExceeded", async () => {
    const client = stubClient({
      statuses: [
        {
          status: {
            failed: 1,
            conditions: [{ type: "Failed", reason: "DeadlineExceeded" }],
          },
        },
      ],
    });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-3", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("timeout");
    expect(markFailed).toHaveBeenCalledTimes(1);
    const firstMarkCall = markFailed.mock.calls[0] as [string, string];
    expect(firstMarkCall[0]).toBe("d-3");
    expect(firstMarkCall[1]).toContain("DeadlineExceeded");
    expect(client.deleteNamespacedJob).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("watchJobCompletion — client-side wall-clock timeout (T046)", () => {
  it("returns 'timeout' when the deadline is reached before K8s reports completion", async () => {
    // Status responses all report "still running" (no succeeded, no
    // failed). The fake sleep advances the clock by pollIntervalMs each
    // iteration so the deadline is guaranteed to fire.
    const client = stubClient({ statuses: [{ status: {} }] });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-4", {
      deadlineMs: 5_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("timeout");
    expect(markFailed).toHaveBeenCalledTimes(1);
    const timeoutMarkCall = markFailed.mock.calls[0] as [string, string];
    expect(timeoutMarkCall[1]).toMatch(/wall-clock deadline/);
    // Best-effort delete of the run-away Job
    expect(client.deleteNamespacedJob).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from deleteNamespacedJob — K8s enforces the deadline anyway", async () => {
    const client = stubClient({
      statuses: [{ status: {} }],
      deleteImpl: () => Promise.reject(new Error("kube api down")),
    });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-5", {
      deadlineMs: 2_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("timeout");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("watchJobCompletion — K8s API errors", () => {
  it("returns 'abandoned' on 404 and still releases the slot", async () => {
    const client = stubClient({
      statuses: [],
      throwOnRead: () => Object.assign(new Error("not found"), { statusCode: 404 }),
    });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-6", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("abandoned");
    expect(markFailed).not.toHaveBeenCalled();
    // T047 invariant: released even on abandoned.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retries on transient 500 and returns once the Job eventually succeeds", async () => {
    // First read throws 500; subsequent reads return success.
    let firstCall = true;
    const client = {
      readNamespacedJobStatus: mock(() => {
        if (firstCall) {
          firstCall = false;
          throw Object.assign(new Error("boom"), { statusCode: 500 });
        }
        return Promise.resolve({ status: { succeeded: 1 } });
      }),
      deleteNamespacedJob: mock(() => Promise.resolve()),
    };
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.resolve());

    const outcome = await watchJobCompletion("d-7", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    expect(outcome).toBe("succeeded");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("watchJobCompletion — T047 invariant", () => {
  it("releases the slot even when releaseInFlight itself throws (does not crash)", async () => {
    const client = stubClient({ statuses: [{ status: { succeeded: 1 } }] });
    const { now, sleep } = fakeClock();
    const markFailed = mock(() => Promise.resolve());
    const release = mock(() => Promise.reject(new Error("valkey down")));

    const outcome = await watchJobCompletion("d-8", {
      deadlineMs: 60_000,
      pollIntervalMs: 1_000,
      injectClient: client,
      injectNow: now,
      injectSleep: sleep,
      injectMarkFailed: markFailed,
      injectReleaseInFlight: release,
    });

    // Watcher must not propagate the release failure — the Job already
    // terminated; surfacing the Valkey error would incorrectly mark the
    // watch as abandoned.
    expect(outcome).toBe("succeeded");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
