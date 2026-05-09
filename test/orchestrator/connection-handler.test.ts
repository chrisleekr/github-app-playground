/**
 * Tests for src/orchestrator/connection-handler.ts
 *
 * Covers: handleWsOpen, handleWsClose, handleDaemonMessage (all message types),
 * getConnections, getDaemonInfo, isDaemonDraining, and internal handlers for
 * daemon:register, heartbeat:pong, daemon:draining, daemon:update-acknowledged,
 * job:accept, job:reject, job:status, job:result.
 *
 * Only leaf dependencies are mocked (daemon-registry, history, job-queue, db, valkey,
 * concurrency, octokit, repo-knowledge, prompt-builder). The three orchestrator
 * modules (connection-handler, job-dispatcher, ws-server) import each other naturally
 * to avoid mock.module() conflicts when all tests run in the same process.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { DaemonCapabilities, DaemonInfo } from "../../src/shared/daemon-types";
import type { DaemonMessage } from "../../src/shared/ws-messages";

// ─── Leaf dependency mocks (shared across all orchestrator tests) ─────────────
// These MUST be declared and registered before any SUT import.
// Only mock modules that are NOT under test — never mock connection-handler,
// job-dispatcher, or ws-server here, because mock.module() is process-wide.

// daemon-registry
const mockRegisterDaemon = mock(
  (): Promise<DaemonInfo> =>
    Promise.resolve({
      id: "daemon-1",
      hostname: "host-1",
      platform: "linux",
      osVersion: "6.1",
      capabilities: makeFakeCapabilities(),
      status: "active",
      protocolVersion: "1.0.0",
      appVersion: "0.1.0",
      activeJobs: 0,
      lastSeenAt: Date.now(),
      firstSeenAt: Date.now(),
    }),
);
const mockDeregisterDaemon = mock(() => Promise.resolve());
const mockRefreshDaemonTtl = mock(() => Promise.resolve());
const mockIncrementDaemonActiveJobs = mock(() => Promise.resolve());
const mockDecrementDaemonActiveJobs = mock(() => Promise.resolve());
const mockGetActiveDaemons = mock((): Promise<string[]> => Promise.resolve([]));
const mockGetDaemonActiveJobs = mock((): Promise<number> => Promise.resolve(0));

void mock.module("../../src/orchestrator/daemon-registry", () => ({
  registerDaemon: mockRegisterDaemon,
  deregisterDaemon: mockDeregisterDaemon,
  refreshDaemonTtl: mockRefreshDaemonTtl,
  incrementDaemonActiveJobs: mockIncrementDaemonActiveJobs,
  decrementDaemonActiveJobs: mockDecrementDaemonActiveJobs,
  getActiveDaemons: mockGetActiveDaemons,
  getDaemonActiveJobs: mockGetDaemonActiveJobs,
}));

// history
const mockGetOrphanedExecutions = mock(
  (): Promise<{ deliveryId: string; status: string }[]> => Promise.resolve([]),
);
const mockMarkExecutionFailed = mock(() => Promise.resolve());
const mockMarkExecutionRunning = mock(() => Promise.resolve());
const mockMarkExecutionCompleted = mock(() => Promise.resolve());
const mockMarkExecutionOffered = mock(() => Promise.resolve());
const mockRequeueExecution = mock(() => Promise.resolve());
const mockGetExecutionState = mock(
  (): Promise<{ status: string; daemonId: string | null } | null> => Promise.resolve(null),
);

void mock.module("../../src/orchestrator/history", () => ({
  getOrphanedExecutions: mockGetOrphanedExecutions,
  markExecutionFailed: mockMarkExecutionFailed,
  markExecutionRunning: mockMarkExecutionRunning,
  markExecutionCompleted: mockMarkExecutionCompleted,
  markExecutionOffered: mockMarkExecutionOffered,
  getExecutionState: mockGetExecutionState,
  requeueExecution: mockRequeueExecution,
}));

// job-queue
const mockRequeueJob = mock((): Promise<boolean> => Promise.resolve(true));
const mockEnqueueJob = mock(() => Promise.resolve());

void mock.module("../../src/orchestrator/job-queue", () => ({
  requeueJob: mockRequeueJob,
  enqueueJob: mockEnqueueJob,
  tryDequeueJob: mock(() => Promise.resolve(null)),
  dequeueJob: mock(() => Promise.resolve(null)),
  isScopedJob: () => false,
  SCOPED_JOB_KINDS: ["scoped-rebase", "scoped-fix-thread", "scoped-open-pr"],
  // Stub the discriminated-union schema so connection-handler's
  // re-validation in `handleScopedAccept` (C2) compiles. Returning
  // `success: false` is fine — the only legacy-flow tests in this file
  // never have `offer.scoped` set, so the validator is unreachable.
  QueuedJobSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
}));

// concurrency
const mockDecrementActiveCount = mock(() => {});

void mock.module("../../src/orchestrator/concurrency", () => ({
  decrementActiveCount: mockDecrementActiveCount,
  incrementActiveCount: mock(() => {}),
  getActiveCount: mock(() => 0),
  isAtCapacity: mock(() => false),
}));

// Mock octokit App
const mockGetRepoInstallation = mock(() => Promise.resolve({ data: { id: 123 } }));
const mockAuth = mock(() => Promise.resolve({ token: "ghs_fake_token" }));
const mockGetInstallationOctokit = mock(() => Promise.resolve({ auth: mockAuth }));

void mock.module("octokit", () => ({
  App: class MockApp {
    octokit = {
      rest: { apps: { getRepoInstallation: mockGetRepoInstallation } },
    };
    getInstallationOctokit = mockGetInstallationOctokit;
  },
  // Real `octokit` package re-exports `Octokit` as a value; the
  // postOrphanNotification PAT short-circuit constructs one directly via
  // `new Octokit({ auth: pat })`. Mock the constructor as an identity-ish
  // shape so the import resolves under bun's mock.module.
  Octokit: class MockOctokit {
    constructor(public options: unknown) {}
  },
}));

// db
const mockDbQuery = mock((): unknown[] => [
  { context_json: { owner: "test-owner", repo: "test-repo", isPR: true, labels: [] } },
]);
const fakeDb = Object.assign(
  (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(mockDbQuery()),
  {},
);
const mockGetDb = mock(() => fakeDb);
const mockRequireDb = mock(() => fakeDb);

void mock.module("../../src/db", () => ({
  getDb: mockGetDb,
  requireDb: mockRequireDb,
}));

void mock.module("../../src/db/index", () => ({
  getDb: mockGetDb,
  requireDb: mockRequireDb,
}));

// valkey
void mock.module("../../src/orchestrator/valkey", () => ({
  requireValkeyClient: mock(() => ({ send: mock(() => Promise.resolve()) })),
  getValkeyClient: mock(() => null),
}));

// repo-knowledge
const mockGetRepoEnvVars = mock(() => Promise.resolve({}));
const mockGetRepoMemory = mock(
  (): Promise<{ id: string; category: string; content: string; pinned: boolean }[]> =>
    Promise.resolve([]),
);
const mockSaveRepoLearnings = mock(() => Promise.resolve(0));
const mockDeleteRepoMemories = mock(() => Promise.resolve(0));

void mock.module("../../src/orchestrator/repo-knowledge", () => ({
  getRepoEnvVars: mockGetRepoEnvVars,
  getRepoMemory: mockGetRepoMemory,
  saveRepoLearnings: mockSaveRepoLearnings,
  deleteRepoMemories: mockDeleteRepoMemories,
}));

// prompt-builder
const mockResolveAllowedTools = mock(() => ["Bash", "Read"]);

void mock.module("../../src/core/prompt-builder", () => ({
  resolveAllowedTools: mockResolveAllowedTools,
  buildPrompt: mock(() => ""),
  buildEnvironmentHeader: mock(() => ""),
}));

// Import AFTER all mocks — these are the real modules, not mocked
const {
  handleWsOpen,
  handleWsClose,
  handleDaemonMessage,
  getConnections,
  getDaemonInfo,
  isDaemonDraining,
} = await import("../../src/orchestrator/connection-handler");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeCapabilities(): DaemonCapabilities {
  return {
    platform: "linux",
    shells: [{ name: "bash", path: "/bin/bash", version: "5.0", functional: true }],
    packageManagers: [{ name: "bun", path: "/usr/bin/bun", version: "1.3.8", functional: true }],
    cliTools: [
      { name: "git", path: "/usr/bin/git", version: "2.40", functional: true },
      { name: "node", path: "/usr/bin/node", version: "22.0", functional: true },
    ],
    containerRuntime: null,
    authContexts: [],
    resources: { cpuCount: 4, memoryTotalMb: 8192, memoryFreeMb: 4096, diskFreeMb: 50000 },
    network: { hostname: "host-1" },
    cachedRepos: [],
    ephemeral: false,
    maxUptimeMs: null,
  };
}

function makeFakeWs(daemonId?: string): {
  data: { authenticated: boolean; remoteAddr: string; daemonId: string | undefined };
  sendText: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return {
    data: {
      authenticated: true,
      remoteAddr: "127.0.0.1",
      daemonId,
    },
    sendText: mock(() => {}),
    close: mock(() => {}),
  };
}

function makeRegisterMsg(
  daemonId = "daemon-1",
  protocolVersion = "1.0.0",
): Extract<DaemonMessage, { type: "daemon:register" }> {
  return {
    type: "daemon:register",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: {
      daemonId,
      hostname: "host-1",
      platform: "linux",
      osVersion: "6.1",
      protocolVersion,
      appVersion: "0.1.0",
      capabilities: makeFakeCapabilities(),
    },
  };
}

function makeHeartbeatPongMsg(): Extract<DaemonMessage, { type: "heartbeat:pong" }> {
  return {
    type: "heartbeat:pong",
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    payload: {
      activeJobs: 1,
      resources: { cpuCount: 4, memoryTotalMb: 8192, memoryFreeMb: 4096, diskFreeMb: 50000 },
    },
  };
}

async function registerDaemon(ws: ReturnType<typeof makeFakeWs>, daemonId: string): Promise<void> {
  const msg = makeRegisterMsg(daemonId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleDaemonMessage(ws as any, msg);
  await new Promise((r) => setTimeout(r, 30));
}

function _makePendingOfferData(
  offerId: string,
  deliveryId: string,
  daemonId: string,
): {
  offerId: string;
  deliveryId: string;
  daemonId: string;
  timer: ReturnType<typeof setTimeout>;
  offeredAt: number;
  retryCount: number;
  repoOwner: string;
  repoName: string;
  entityNumber: number;
  isPR: boolean;
  eventName: string;
  triggerUsername: string;
  labels: string[];
  triggerBodyPreview: string;
} {
  return {
    offerId,
    deliveryId,
    daemonId,
    timer: setTimeout(() => {}, 60000),
    offeredAt: Date.now(),
    retryCount: 0,
    repoOwner: "test-owner",
    repoName: "test-repo",
    entityNumber: 1,
    isPR: true,
    eventName: "issue_comment",
    triggerUsername: "user1",
    labels: [],
    triggerBodyPreview: "test body",
  };
}

/** Extract offerId from mock sendText calls by finding the job:offer message. */
function extractOfferId(ws: ReturnType<typeof makeFakeWs>): string {
  const calls = ws.sendText.mock.calls;
  const offerCall = calls.find((c) => {
    const p = JSON.parse(c[0] as string) as { type: string };
    return p.type === "job:offer";
  });
  if (offerCall === undefined) {
    throw new Error("Expected a job:offer message in sendText calls");
  }
  return (JSON.parse(offerCall[0] as string) as { id: string }).id;
}

// ─── Reset ────────────────────────────────────────────────────────────────────

function resetAllMocks(): void {
  for (const m of [
    mockRegisterDaemon,
    mockDeregisterDaemon,
    mockRefreshDaemonTtl,
    mockGetOrphanedExecutions,
    mockMarkExecutionFailed,
    mockMarkExecutionRunning,
    mockMarkExecutionCompleted,
    mockMarkExecutionOffered,
    mockGetExecutionState,
    mockRequeueExecution,
    mockDecrementActiveCount,
    mockIncrementDaemonActiveJobs,
    mockDecrementDaemonActiveJobs,
    mockGetActiveDaemons,
    mockGetDaemonActiveJobs,
    mockRequeueJob,
    mockDbQuery,
    mockGetDb,
    mockRequireDb,
    mockGetRepoEnvVars,
    mockGetRepoMemory,
    mockSaveRepoLearnings,
    mockDeleteRepoMemories,
    mockResolveAllowedTools,
    mockGetRepoInstallation,
    mockAuth,
    mockGetInstallationOctokit,
  ]) {
    m.mockClear();
  }

  // Restore default implementations
  mockRegisterDaemon.mockImplementation(() =>
    Promise.resolve({
      id: "daemon-1",
      hostname: "host-1",
      platform: "linux",
      osVersion: "6.1",
      capabilities: makeFakeCapabilities(),
      status: "active",
      protocolVersion: "1.0.0",
      appVersion: "0.1.0",
      activeJobs: 0,
      lastSeenAt: Date.now(),
      firstSeenAt: Date.now(),
    }),
  );
  mockDeregisterDaemon.mockImplementation(() => Promise.resolve());
  mockGetOrphanedExecutions.mockImplementation(() => Promise.resolve([]));
  mockMarkExecutionFailed.mockImplementation(() => Promise.resolve());
  mockMarkExecutionRunning.mockImplementation(() => Promise.resolve());
  mockMarkExecutionCompleted.mockImplementation(() => Promise.resolve());
  mockMarkExecutionOffered.mockImplementation(() => Promise.resolve());
  mockGetExecutionState.mockImplementation(() => Promise.resolve(null));
  mockRequeueExecution.mockImplementation(() => Promise.resolve());
  mockGetActiveDaemons.mockImplementation(() => Promise.resolve([]));
  mockGetDaemonActiveJobs.mockImplementation(() => Promise.resolve(0));
  mockRequeueJob.mockImplementation(() => Promise.resolve(true));
  mockDbQuery.mockImplementation(() => [
    { context_json: { owner: "test-owner", repo: "test-repo", isPR: true, labels: [] } },
  ]);
  mockGetDb.mockImplementation(() => fakeDb);
  mockRequireDb.mockImplementation(() => fakeDb);
  mockGetRepoInstallation.mockImplementation(() => Promise.resolve({ data: { id: 123 } }));
  mockAuth.mockImplementation(() => Promise.resolve({ token: "ghs_fake_token" }));
  mockGetInstallationOctokit.mockImplementation(() => Promise.resolve({ auth: mockAuth }));
  mockSaveRepoLearnings.mockImplementation(() => Promise.resolve(0));
  mockDeleteRepoMemories.mockImplementation(() => Promise.resolve(0));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getConnections().clear();
  resetAllMocks();
});

describe("handleWsOpen", () => {
  it("is a no-op (does not throw)", () => {
    const ws = makeFakeWs();

    expect(() => {
      handleWsOpen(ws as any);
    }).not.toThrow();
  });
});

describe("handleWsClose", () => {
  it("returns early when daemonId is undefined", () => {
    const ws = makeFakeWs(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWsClose(ws as any, 1000, "normal");
    expect(mockDeregisterDaemon).not.toHaveBeenCalled();
  });

  it("cleans up connection state and triggers async cleanup", async () => {
    const ws = makeFakeWs("daemon-1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-1", ws as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWsClose(ws as any, 1000, "normal");

    expect(getConnections().has("daemon-1")).toBe(false);

    await new Promise((r) => setTimeout(r, 30));
    expect(mockDeregisterDaemon).toHaveBeenCalledWith("daemon-1");
  });

  it("marks orphaned executions as failed during cleanup", async () => {
    const ws = makeFakeWs("daemon-2");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-2", ws as any);

    mockGetOrphanedExecutions.mockImplementation(() =>
      Promise.resolve([{ deliveryId: "orphan-1", status: "running" }]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWsClose(ws as any, 1000, "normal");

    await new Promise((r) => setTimeout(r, 30));
    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "orphan-1",
      "daemon disconnected during execution",
    );
  });

  it("handles cleanup errors gracefully", async () => {
    const ws = makeFakeWs("daemon-err");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-err", ws as any);

    mockDeregisterDaemon.mockImplementation(() => Promise.reject(new Error("Valkey down")));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWsClose(ws as any, 1000, "normal");
    await new Promise((r) => setTimeout(r, 30));
    // Should not throw
  });

  it("handles individual orphan failure gracefully", async () => {
    const ws = makeFakeWs("daemon-orf");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-orf", ws as any);

    mockGetOrphanedExecutions.mockImplementation(() =>
      Promise.resolve([
        { deliveryId: "orf-1", status: "running" },
        { deliveryId: "orf-2", status: "running" },
      ]),
    );
    let calls = 0;
    mockMarkExecutionFailed.mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("DB error"));
      return Promise.resolve();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleWsClose(ws as any, 1000, "normal");

    await new Promise((r) => setTimeout(r, 50));
    expect(mockMarkExecutionFailed).toHaveBeenCalledTimes(2);
  });
});

describe("getConnections / getDaemonInfo / isDaemonDraining", () => {
  it("returns the connections map", () => {
    expect(getConnections()).toBeInstanceOf(Map);
  });

  it("returns undefined for unknown daemon info", () => {
    expect(getDaemonInfo("nonexistent")).toBeUndefined();
  });

  it("returns false for non-draining daemon", () => {
    expect(isDaemonDraining("nonexistent")).toBe(false);
  });
});

describe("handleDaemonMessage - daemon:register", () => {
  it("registers a new daemon successfully", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-new");

    expect(mockRegisterDaemon).toHaveBeenCalled();
    expect(ws.data.daemonId).toBe("daemon-new");
    expect(getConnections().has("daemon-new")).toBe(true);
    expect(ws.sendText).toHaveBeenCalled();

    const sentText = ws.sendText.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { type: string };
    expect(parsed.type).toBe("daemon:registered");
  });

  it("closes old connection on FM-8 reconnection", async () => {
    const oldWs = makeFakeWs("daemon-rc");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-rc", oldWs as any);

    const newWs = makeFakeWs();
    await registerDaemon(newWs, "daemon-rc");

    expect(oldWs.close).toHaveBeenCalled();
    expect(oldWs.data.daemonId).toBeUndefined();
    expect(newWs.data.daemonId).toBe("daemon-rc");
  });

  it("rejects incompatible protocol version", async () => {
    const ws = makeFakeWs();
    const msg = makeRegisterMsg("daemon-v2", "2.0.0");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, msg);
    await new Promise((r) => setTimeout(r, 30));

    expect(ws.close).toHaveBeenCalled();
    const closeArgs = ws.close.mock.calls[0];
    expect(closeArgs?.[0]).toBe(4003);
  });

  it("sends error on registration failure", async () => {
    mockRegisterDaemon.mockImplementation(() => Promise.reject(new Error("Valkey down")));

    const ws = makeFakeWs();
    const msg = makeRegisterMsg("daemon-fail");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, msg);
    await new Promise((r) => setTimeout(r, 30));

    // sendError is called from ws-server module (real import)
    // Verify the daemon was NOT registered
    expect(ws.data.daemonId).toBeUndefined();
  });

  it("cleans orphaned executions from previous session on reconnection", async () => {
    const oldWs = makeFakeWs("daemon-orph");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getConnections().set("daemon-orph", oldWs as any);

    mockGetOrphanedExecutions.mockImplementation(() =>
      Promise.resolve([{ deliveryId: "prev-orphan-1", status: "running" }]),
    );

    const newWs = makeFakeWs();
    await registerDaemon(newWs, "daemon-orph");

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "prev-orphan-1",
      "daemon reconnected — previous session orphaned",
    );
  });
});

describe("handleDaemonMessage - heartbeat:pong", () => {
  it("updates daemon info on pong", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-hb");

    const pongMsg = makeHeartbeatPongMsg();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, pongMsg);

    const info = getDaemonInfo("daemon-hb");
    expect(info).toBeDefined();
    if (info === undefined) {
      throw new Error("Expected daemon info to be defined");
    }
    expect(info.activeJobs).toBe(1);
    expect(info.capabilities.resources.cpuCount).toBe(4);
  });

  it("returns early when daemonId is undefined", () => {
    const ws = makeFakeWs(undefined);
    const pongMsg = makeHeartbeatPongMsg();

    expect(() => {
      handleDaemonMessage(ws as any, pongMsg);
    }).not.toThrow();
  });
});

describe("handleDaemonMessage - daemon:draining", () => {
  it("marks daemon as draining", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-drain");

    const drainingMsg: DaemonMessage = {
      type: "daemon:draining",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { activeJobs: 2, reason: "update" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, drainingMsg);

    expect(isDaemonDraining("daemon-drain")).toBe(true);
    const info = getDaemonInfo("daemon-drain");
    expect(info?.status).toBe("draining");
  });

  it("returns early when daemonId is undefined", () => {
    const ws = makeFakeWs(undefined);
    const drainingMsg: DaemonMessage = {
      type: "daemon:draining",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { activeJobs: 0, reason: "shutdown" },
    };

    expect(() => {
      handleDaemonMessage(ws as any, drainingMsg);
    }).not.toThrow();
  });
});

describe("handleDaemonMessage - daemon:update-acknowledged", () => {
  it("sets daemon status to updating", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-upd");

    const updateMsg: DaemonMessage = {
      type: "daemon:update-acknowledged",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { strategy: "exit", delayMs: 5000 },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, updateMsg);

    const info = getDaemonInfo("daemon-upd");
    expect(info?.status).toBe("updating");
  });

  it("returns early when daemonId is undefined", () => {
    const ws = makeFakeWs(undefined);
    const updateMsg: DaemonMessage = {
      type: "daemon:update-acknowledged",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { strategy: "pull", delayMs: 0 },
    };

    expect(() => {
      handleDaemonMessage(ws as any, updateMsg);
    }).not.toThrow();
  });
});

describe("handleDaemonMessage - job:accept", () => {
  it("processes accept with valid pending offer", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-acc");

    // Manually set up a pending offer via dispatchJob flow
    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-acc"]));

    const result = await realDispatch({
      deliveryId: "del-1",
      repoOwner: "test-owner",
      repoName: "test-repo",
      entityNumber: 1,
      isPR: true,
      eventName: "issue_comment",
      triggerUsername: "user1",
      labels: [],
      triggerBodyPreview: "test body",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });
    expect(result).toBe(true);

    // Get the offerId from the sent offer message
    const offerId = extractOfferId(ws);

    // Now send job:accept with that offerId
    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: offerId,
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockIncrementDaemonActiveJobs).toHaveBeenCalledWith("daemon-acc");
    expect(mockMarkExecutionRunning).toHaveBeenCalledWith("del-1");
  });

  it("returns early for unknown offer", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-unk");

    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    await new Promise((r) => setTimeout(r, 30));
    // No side effects expected
    expect(mockIncrementDaemonActiveJobs).not.toHaveBeenCalled();
  });

  it("fails when database not available", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-nodb");

    // Create pending offer via dispatch
    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-nodb"]));
    await realDispatch({
      deliveryId: "del-nodb",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "u",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const offerId = extractOfferId(ws);

    // Now make db unavailable
    mockGetDb.mockImplementation(() => null);

    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: offerId,
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith("del-nodb", "Database unavailable");
    expect(mockDecrementActiveCount).toHaveBeenCalled();
  });

  it("fails when no context_json in database", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-noctx");

    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-noctx"]));
    await realDispatch({
      deliveryId: "del-noctx",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "u",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const offerId = extractOfferId(ws);

    mockDbQuery.mockImplementation(() => [{ context_json: null }]);

    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: offerId,
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "del-noctx",
      "Execution context not found",
    );
  });

  it("handles installation token minting failure", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-tokfail");

    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-tokfail"]));
    await realDispatch({
      deliveryId: "del-tokfail",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "u",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const offerId = extractOfferId(ws);

    mockGetRepoInstallation.mockImplementation(() => Promise.reject(new Error("Not found")));

    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: offerId,
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "del-tokfail",
      "Failed to mint installation token",
    );
  });

  it("sends error when job message from unregistered daemon", () => {
    const ws = makeFakeWs(undefined);
    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {},
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);

    // sendError is called on ws (via real ws-server module)
    expect(ws.sendText).toHaveBeenCalled();
    const sentText = ws.sendText.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(sentText) as { type: string };
    expect(parsed.type).toBe("error");
  });
});

describe("handleDaemonMessage - job:reject", () => {
  it("delegates to handleJobReject", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-rej");

    // Create a pending offer
    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-rej"]));
    await realDispatch({
      deliveryId: "del-reject",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "u",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const offerId = extractOfferId(ws);

    const rejectMsg: DaemonMessage = {
      type: "job:reject",
      id: offerId,
      timestamp: Date.now(),
      payload: { reason: "no capacity" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, rejectMsg);

    await new Promise((r) => setTimeout(r, 30));
    expect(mockRequeueExecution).toHaveBeenCalledWith("del-reject");
  });
});

describe("handleDaemonMessage - job:status", () => {
  it("processes status update without error", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-st");

    const statusMsg: DaemonMessage = {
      type: "job:status",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { status: "running", message: "cloning repo" },
    };

    expect(() => {
      handleDaemonMessage(ws as any, statusMsg);
    }).not.toThrow();
  });
});

describe("handleDaemonMessage - job:result", () => {
  it("finalizes execution on successful result", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-res");

    // Create pending offer
    const { dispatchJob: realDispatch } = await import("../../src/orchestrator/job-dispatcher");
    mockGetActiveDaemons.mockImplementation(() => Promise.resolve(["daemon-res"]));
    await realDispatch({
      deliveryId: "del-result",
      repoOwner: "o",
      repoName: "r",
      entityNumber: 1,
      isPR: false,
      eventName: "issue_comment",
      triggerUsername: "u",
      labels: [],
      triggerBodyPreview: "",
      enqueuedAt: Date.now(),
      retryCount: 0,
    });

    const offerId = extractOfferId(ws);

    // First accept so the offer gets removed and execution is marked running
    const acceptMsg: DaemonMessage = {
      type: "job:accept",
      id: offerId,
      timestamp: Date.now(),
      payload: {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, acceptMsg);
    await new Promise((r) => setTimeout(r, 80));

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-res" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: offerId,
      timestamp: Date.now(),
      payload: {
        success: true,
        deliveryId: "del-result",
        costUsd: 0.05,
        durationMs: 3000,
        numTurns: 5,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockDecrementDaemonActiveJobs).toHaveBeenCalledWith("daemon-res");
    expect(mockDecrementActiveCount).toHaveBeenCalled();
    expect(mockMarkExecutionCompleted).toHaveBeenCalled();
  });

  it("finalizes execution on failed result", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-fail-res");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-fail-res" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        success: false,
        deliveryId: "del-fail-result",
        errorMessage: "Agent crashed",
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith("del-fail-result", "Agent crashed");
  });

  it("discards late result for already-completed execution (FM-6)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-late");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "completed", daemonId: "daemon-late" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true, deliveryId: "del-late" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });

  it("discards late result for already-failed execution (FM-6)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-latefail");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "failed", daemonId: "daemon-latefail" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true, deliveryId: "del-latefail" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });

  it("discards result from non-assigned daemon (FM-6)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-wrong");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-other" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true, deliveryId: "del-wrong" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });

  it("returns early when deliveryId cannot be resolved", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-nodel");

    mockDbQuery.mockImplementation(() => []);

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });

  it("resolves deliveryId from payload when offer not in map", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-payld");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-payld" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        success: true,
        deliveryId: "del-from-payload",
        costUsd: 0.01,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).toHaveBeenCalled();
  });

  it("persists learnings from result", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-learn");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-learn" }),
    );

    mockDbQuery.mockImplementation(() => [{ repo_owner: "o", repo_name: "r" }]);
    mockSaveRepoLearnings.mockImplementation(() => Promise.resolve(1));

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        success: true,
        deliveryId: "del-learn",
        learnings: [{ category: "convention", content: "use strict mode" }],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockSaveRepoLearnings).toHaveBeenCalled();
  });

  it("processes deletions from result", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-del");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-del" }),
    );

    mockDbQuery.mockImplementation(() => [{ repo_owner: "o", repo_name: "r" }]);
    mockDeleteRepoMemories.mockImplementation(() => Promise.resolve(2));

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        success: true,
        deliveryId: "del-del",
        deletions: ["mem-1", "mem-2"],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockDeleteRepoMemories).toHaveBeenCalledWith(["mem-1", "mem-2"]);
  });

  it("handles failed result with default error message", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-defmsg");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-defmsg" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: false, deliveryId: "del-defmsg" },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "del-defmsg",
      "Execution failed on daemon",
    );
  });

  it("resolves deliveryId from DB fallback", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-dbfb");

    mockDbQuery.mockImplementation(() => [{ delivery_id: "del-from-db" }]);
    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-dbfb" }),
    );

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).toHaveBeenCalled();
  });

  it("returns early when db is null in resolveDeliveryId fallback", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-nulldb");

    mockGetDb.mockImplementation(() => null);

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });

  it("processes result with null execution state", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-nullst");

    mockGetExecutionState.mockImplementation(() => Promise.resolve(null));

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: { success: true, deliveryId: "del-nullst", durationMs: 1000 },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).toHaveBeenCalled();
  });

  it("handles persistRepoKnowledge failure gracefully", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-pkfail");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-pkfail" }),
    );

    mockRequireDb.mockImplementation(() => {
      throw new Error("DB gone");
    });

    const resultMsg: DaemonMessage = {
      type: "job:result",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        success: true,
        deliveryId: "del-pkfail",
        learnings: [{ category: "bug", content: "something" }],
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, resultMsg);

    await new Promise((r) => setTimeout(r, 80));

    expect(mockMarkExecutionCompleted).toHaveBeenCalled();
  });
});

// C4: handleScopedJobCompletion must decrement active-count and
// daemon-active-jobs for both succeeded and halted/failed branches —
// otherwise every scoped run leaks one capacity slot.
describe("handleDaemonMessage - scoped-job-completion (C4)", () => {
  beforeEach(() => {
    mockDecrementActiveCount.mockClear();
    mockDecrementDaemonActiveJobs.mockClear();
    mockMarkExecutionFailed.mockClear();
    mockMarkExecutionCompleted.mockClear();
  });

  it("decrements capacity and does NOT mark failed on succeeded", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-scoped-ok");

    // Seed durable state so the ownership/late-result guard passes.
    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-scoped-ok" }),
    );

    const completionMsg = {
      type: "scoped-job-completion",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        offerId: "offer-ok",
        deliveryId: "del-scoped-ok",
        jobKind: "scoped-rebase",
        status: "succeeded",
        durationMs: 100,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, completionMsg);

    await new Promise((r) => setTimeout(r, 30));

    expect(mockDecrementActiveCount).toHaveBeenCalled();
    expect(mockDecrementDaemonActiveJobs).toHaveBeenCalledWith("daemon-scoped-ok");
    expect(mockMarkExecutionFailed).not.toHaveBeenCalled();
    expect(mockMarkExecutionCompleted).toHaveBeenCalledWith("del-scoped-ok", {});
  });

  it("decrements capacity and marks executions failed on failed", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-scoped-fail");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-scoped-fail" }),
    );

    const completionMsg = {
      type: "scoped-job-completion",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        offerId: "offer-fail",
        deliveryId: "del-scoped-fail",
        jobKind: "scoped-rebase",
        status: "failed",
        durationMs: 100,
        reason: "network blip",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, completionMsg);

    await new Promise((r) => setTimeout(r, 30));

    expect(mockDecrementActiveCount).toHaveBeenCalled();
    expect(mockDecrementDaemonActiveJobs).toHaveBeenCalledWith("daemon-scoped-fail");
    expect(mockMarkExecutionFailed).toHaveBeenCalledWith(
      "del-scoped-fail",
      expect.stringContaining("scoped-job daemon failed"),
    );
  });

  it("decrements capacity and marks completed on halted (scaffolding-only outcome)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-scoped-halted");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-scoped-halted" }),
    );

    const completionMsg = {
      type: "scoped-job-completion",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        offerId: "offer-halted",
        deliveryId: "del-scoped-halted",
        jobKind: "scoped-fix-thread",
        status: "halted",
        durationMs: 50,
        reason: "agent-sdk invocation pending follow-up",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, completionMsg);

    await new Promise((r) => setTimeout(r, 30));

    expect(mockDecrementActiveCount).toHaveBeenCalled();
    expect(mockDecrementDaemonActiveJobs).toHaveBeenCalledWith("daemon-scoped-halted");
    // halted is contractually a non-failure outcome — executions row should
    // NOT be marked failed, but it MUST receive a terminal write so the
    // row leaves 'running'.
    expect(mockMarkExecutionFailed).not.toHaveBeenCalled();
    expect(mockMarkExecutionCompleted).toHaveBeenCalledWith("del-scoped-halted", {});
  });

  it("ignores completion when execution state daemon does not match sender (forged/replay)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-impostor");

    // Durable state shows a different daemon owns this delivery.
    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "running", daemonId: "daemon-real-owner" }),
    );

    const completionMsg = {
      type: "scoped-job-completion",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        offerId: "offer-stolen",
        deliveryId: "del-stolen",
        jobKind: "scoped-rebase",
        status: "succeeded",
        durationMs: 100,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, completionMsg);

    await new Promise((r) => setTimeout(r, 30));

    expect(mockDecrementActiveCount).not.toHaveBeenCalled();
    expect(mockDecrementDaemonActiveJobs).not.toHaveBeenCalled();
    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
    expect(mockMarkExecutionFailed).not.toHaveBeenCalled();
  });

  it("ignores completion when execution is already finalized (late result)", async () => {
    const ws = makeFakeWs();
    await registerDaemon(ws, "daemon-late");

    mockGetExecutionState.mockImplementation(() =>
      Promise.resolve({ status: "completed", daemonId: "daemon-late" }),
    );

    const completionMsg = {
      type: "scoped-job-completion",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      payload: {
        offerId: "offer-late",
        deliveryId: "del-late",
        jobKind: "scoped-rebase",
        status: "succeeded",
        durationMs: 100,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handleDaemonMessage(ws as any, completionMsg);

    await new Promise((r) => setTimeout(r, 30));

    expect(mockDecrementActiveCount).not.toHaveBeenCalled();
    expect(mockDecrementDaemonActiveJobs).not.toHaveBeenCalled();
    expect(mockMarkExecutionCompleted).not.toHaveBeenCalled();
  });
});
