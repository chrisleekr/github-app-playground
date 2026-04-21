# Contract: Composite Workflow Hand-off Protocol

How `ship` (and any future composite) advances between steps. FR mapping: FR-006, FR-028, FR-029.

## Start

1. Top-level dispatch creates the parent row: `INSERT INTO workflow_runs (workflow_name='ship', target=issue, status='queued', state='{"currentStepIndex":0,"stepRuns":[]}', parent_run_id=NULL)`.
2. Parent's handler (`handlers/ship.ts`) runs and its entire job is:
   - Enqueue step 0 as a child: `INSERT INTO workflow_runs (workflow_name=registry.get('ship').steps[0], parent_run_id=parentId, parent_step_index=0, status='queued')`, then publish a job carrying the child run id.
   - Return `status: 'succeeded'` with state `{ handedOffTo: childRunId }`. The parent row stays `running` (see §Parent status below).

## Per-step completion

For every child run, `orchestrator.onStepComplete(childRunId, result)` runs as the last step inside the daemon job, before ACK:

```
BEGIN TRANSACTION
  UPDATE workflow_runs
    SET status = result.status,   -- 'succeeded' or 'failed'
        state  = state || result.state,
        updated_at = now()
    WHERE id = childRunId;

  IF child has no parent_run_id: COMMIT, emit tracking-comment update, RETURN.

  SELECT parent row FOR UPDATE;

  IF result.status = 'succeeded':
    nextIndex := child.parent_step_index + 1
    parentSteps := registry[parent.workflow_name].steps
    IF nextIndex >= len(parentSteps):
      UPDATE parent SET status='succeeded', state = state || '{"currentStepIndex":nextIndex}'
    ELSE:
      INSERT INTO workflow_runs (workflow_name=parentSteps[nextIndex],
                                 parent_run_id=parent.id,
                                 parent_step_index=nextIndex,
                                 status='queued',
                                 target=parent.target)
      RETURNING nextChildRunId;
      UPDATE parent SET state = state || {"currentStepIndex": nextIndex,
                                          "stepRuns": state.stepRuns || [nextChildRunId]}
      -- parent status stays 'running'
  ELSE: -- result.status = 'failed'
    UPDATE parent SET status='failed',
                      state = state || '{"failedAtStepIndex": child.parent_step_index,
                                         "failedReason": result.reason}'
COMMIT

IF new child was inserted:
  LPUSH <job-queue> {workflowRunId: nextChildRunId, ...}   -- outside the DB txn

Emit tracking-comment update for both parent and child.
```

## Skip-if-output-exists (FR-020)

When `ship` is re-applied to an issue that already has a successful `implement` run (which produced an open PR), the dispatcher (not the orchestrator) handles it:

1. Dispatch creates the parent row.
2. `handlers/ship.ts` inspects `workflow_runs` for prior successes of each step in `steps`.
3. It sets `state.currentStepIndex` to the index of the first step whose output is missing or stale, inserts a child at that index, and enqueues it. Earlier steps are recorded in `state.stepRuns` by reference to their prior run ids.

### Staleness rules (per step)

Exactly one rule per atomic workflow, applied left-to-right. A step is **fresh** iff its rule holds; otherwise it is **stale** and re-run.

| Step        | Fresh iff …                                                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`    | There exists a `succeeded` `triage` row for this issue whose `state.verdict === 'valid'`. A non-valid verdict (stale/invalid/needs-more-info) makes the step stale — `ship` MUST re-triage because the previous verdict was a halt signal, not a usable input.                                        |
| `plan`      | There exists a `succeeded` `plan` row whose `created_at` is later than the `created_at` of the most recent `succeeded` `triage` row for this issue. This prevents reusing a plan that was written against a now-superseded triage verdict.                                                            |
| `implement` | There exists a `succeeded` `implement` row **and** the PR number it recorded in `state.pr_number` is still open (verified via a live `octokit.rest.pulls.get` call) **and** the PR's head branch has not been force-pushed away from the implement's recorded head SHA. Otherwise implement is stale. |
| `review`    | Always stale — `review` on a resume MUST re-monitor CI and comments because both evolve independently of bot action. No short-circuit.                                                                                                                                                                |

`ship.ts` evaluates the rules against the most recent `succeeded` run per step, in step-order, stopping at the first stale step — that becomes `currentStepIndex`.

This is where "resume from review" (FR-020) and "resume mid-ship from last completed stage" (FR-013) both fall out of a single mechanism.

## Parent status while in flight

A composite parent row holds `status='running'` for its entire lifetime — from when its first child is enqueued until either:

- The last step succeeds → parent → `succeeded`.
- Any step fails terminally → parent → `failed` and no further enqueue (FR-029).

The partial unique index on `(workflow_name, target_*)` with `status IN ('queued','running')` is what prevents a second `bot:ship` from opening a duplicate parent while one is in flight.

## Failure semantics

- **Handler throws**: daemon catches, writes `status='failed'` with `reason='uncaught: <message>'`, proceeds to parent-cascade step above.
- **Daemon crashes mid-run**: next daemon to reclaim the job sees `status='running'` older than the claim lease; the daemon-level lease-expiry logic (already present in `src/orchestrator/job-dispatcher.ts`) either reassigns or moves it to `failed` after the configured retry cap. Parent-cascade runs on the final `failed` write.
- **DB write fails after handler succeeds**: the transaction is atomic; either both the child's succeeded write and the next-step insert happen, or neither does. If the post-commit enqueue fails, a reconciler (not in v1 scope — deferred) would re-enqueue from rows where `status='queued'` but no queue presence exists. For v1 this gap is acceptable because the parent row carries `state.currentStepIndex` and a maintainer can re-apply `bot:ship` to resume (FR-013).

## Invariants

1. A row with `parent_run_id IS NOT NULL` always has `parent_step_index = <registry>[parent.workflow_name].steps.indexOf(child.workflow_name)` for the specific parent.
2. `state.stepRuns` on a parent is always in ascending `parent_step_index` order.
3. A parent's `state.currentStepIndex` equals the `parent_step_index` of its latest child, or `len(steps)` if terminal.
4. There is at most one child of a given `(parent_run_id, parent_step_index)`.
