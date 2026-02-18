import { describe, expect, it, mock } from "bun:test";

import { retryWithBackoff } from "../../src/utils/retry";

/** Minimal silent logger for tests — suppresses pino output */
const silentLog = {
  warn: mock(() => {}),
  error: mock(() => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
  child: mock(function () {
    return this;
  }),
} as never;

function makeStatusError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

/** Assert that a retryWithBackoff call throws the expected message in one attempt. */
async function expectImmedateThrow(
  op: () => Promise<unknown>,
  expectedMsg: string,
  expectedCalls: number,
): Promise<void> {
  let thrownMsg = "";
  try {
    await retryWithBackoff(op, { maxAttempts: 3, initialDelayMs: 1, log: silentLog });
  } catch (e) {
    thrownMsg = e instanceof Error ? e.message : String(e);
  }
  expect(thrownMsg).toContain(expectedMsg);
  expect((op as ReturnType<typeof mock>).mock.calls.length).toBe(expectedCalls);
}

describe("retryWithBackoff — success path", () => {
  it("returns the result on first successful attempt", async () => {
    const op = mock(() => Promise.resolve("ok"));
    const result = await retryWithBackoff(op, { log: silentLog });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on a generic error and succeeds on the second attempt", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve("recovered");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("recovered");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff — 4xx non-retriable errors", () => {
  it("does NOT retry on 400 Bad Request", async () => {
    const op = mock(() => Promise.reject(makeStatusError(400)));
    await expectImmedateThrow(op, "HTTP 400", 1);
  });

  it("does NOT retry on 403 Forbidden", async () => {
    const op = mock(() => Promise.reject(makeStatusError(403)));
    await expectImmedateThrow(op, "HTTP 403", 1);
  });

  it("does NOT retry on 404 Not Found", async () => {
    const op = mock(() => Promise.reject(makeStatusError(404)));
    await expectImmedateThrow(op, "HTTP 404", 1);
  });

  it("does NOT retry on 422 Unprocessable Entity", async () => {
    const op = mock(() => Promise.reject(makeStatusError(422)));
    await expectImmedateThrow(op, "HTTP 422", 1);
  });
});

describe("retryWithBackoff — 429 Too Many Requests (should retry)", () => {
  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(makeStatusError(429));
      return Promise.resolve("after-rate-limit");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("after-rate-limit");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff — 5xx server errors (should retry)", () => {
  it("retries on 500 Internal Server Error", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls < 3) return Promise.reject(makeStatusError(500));
      return Promise.resolve("ok");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("retries on 503 Service Unavailable", async () => {
    let calls = 0;
    const op = mock(() => {
      calls++;
      if (calls === 1) return Promise.reject(makeStatusError(503));
      return Promise.resolve("ok");
    });
    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      initialDelayMs: 1,
      log: silentLog,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe("retryWithBackoff — exhaustion", () => {
  it("throws the last error after all attempts are exhausted", async () => {
    const op = mock(() => Promise.reject(new Error("always fails")));
    let thrownMsg = "";
    try {
      await retryWithBackoff(op, { maxAttempts: 3, initialDelayMs: 1, log: silentLog });
    } catch (e) {
      thrownMsg = e instanceof Error ? e.message : String(e);
    }
    expect(thrownMsg).toBe("always fails");
    expect(op).toHaveBeenCalledTimes(3);
  });
});
