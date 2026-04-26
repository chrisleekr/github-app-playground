# Issue #16 — agent timeout abort controller

## Summary

The agent's wall-clock timeout used `Promise.race(agentLoop, timeoutPromise)`, which only rejected the racing promise — the losing `agentLoop` kept streaming tokens, kept the workspace pinned, and let the SDK subprocess (and its MCP servers) outlive the request. The daemon's `handleJobCancel` had no way to terminate a runaway agent for the same reason: `executeAgent` never accepted a cancellation signal.

The fix replaces the race with an `AbortController` plumbed into the Claude Agent SDK's `query({ options: { abortController } })`. The wall-clock `setTimeout` now aborts that controller (instead of just rejecting), and the iterator tears down — closing the subprocess and MCP servers. `executeAgent` also accepts an optional caller `signal` (e.g. the daemon's per-job `AbortController.signal`) and forwards `abort` events to the SDK controller, so `handleJobCancel` actually stops in-flight work. The timer is cleared in `finally` so the happy path no longer pins the Bun event loop for up to `agentTimeoutMs` after a successful run.

## Files changed

- `src/core/executor.ts` — added `signal?: AbortSignal` to `ExecuteAgentParams`; created an `AbortController` linked to the caller signal and wired it into `queryOptions.abortController`; replaced `Promise.race` with `await agentLoop` inside try/finally; timer aborts via `controller.abort(<error>)` and is cleared in `finally`; caller signal listener removed in `finally`.
- `src/core/pipeline.ts` — added `signal?: AbortSignal` to `RunPipelineOverrides` and forwards it to `executeAgent` (only when defined, to keep `exactOptionalPropertyTypes` happy).
- `src/daemon/job-executor.ts` — passes `abortController.signal` from the existing per-job controller into `runPipeline`, so `handleJobCancel`'s `abortController.abort()` now actually terminates the SDK iterator. Updated the comment block on `agentPid` to explain the controller-based teardown.
- `test/core/executor.test.ts` — new file. Five unit tests covering the cancellation surface; mocks `@anthropic-ai/claude-agent-sdk` at module load.

## Commits

- `695475d` — `fix(pipeline): abort SDK query on timeout and daemon cancel`

## Tests run

- `bun run typecheck` — pass
- `bun run lint` — 0 errors in changed files
- `bun test test/core/executor.test.ts` — 5 pass / 0 fail (113 ms; process exits promptly, validating the `clearTimeout` fix)
- `bun test test/core/ test/workflows/handlers/` — 140 pass / 0 fail
- Full `bun test` — no regressions vs `main`; pre-existing failures are infrastructure-dependent (Postgres/Valkey not running) and cross-file `mock.module` interactions unrelated to this change.

## Verification

1. **Unit (test/core/executor.test.ts)**
   - `lastQueryCall.options.abortController` is the controller `executeAgent` constructed (forwards correctly).
   - With `config.agentTimeoutMs = 25` and an iterator that resolves on abort, the iterator's `signal.reason` is an `Error("Agent execution timed out after 25ms")` — confirming the timer reaches the SDK.
   - On the happy path, `clearTimeout` is called with the same handle that `setTimeout(..., 60_000)` returned — proving the wall-clock timer no longer pins the event loop.
   - Pre-aborted caller signal: `result.success === false` and `lastQueryCall.options.abortController.signal.aborted === true` — the abort short-circuits and propagates.
   - Mid-execution caller abort: a `queueMicrotask` triggers `controller.abort()` after the iterator starts; the SDK controller observes `aborted === true` and `executeAgent` resolves with `success: false`.

2. **Integration boundary**
   - `runPipeline` only forwards the signal when defined (`...(overrides.signal !== undefined ? { signal: overrides.signal } : {})`), preserving `exactOptionalPropertyTypes`.
   - `executeJob` already creates a `jobAbortControllers` per offerId and aborts it in `handleJobCancel`; this PR closes the gap by piping `abortController.signal` into `runPipeline`. The existing duplicate-`job:result` guard (`if (!abortController.signal.aborted)`) keeps cancel-vs-success races correct.

3. **Static checks**
   - `bun run typecheck` covers the new `signal` field on `ExecuteAgentParams` and `RunPipelineOverrides`.
   - `bun run lint` clean for the new file.

Closes #16.
