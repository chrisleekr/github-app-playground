# Contract: Webhook → Workflow Dispatch

How label and comment events become enqueued workflow runs. FR mapping: FR-007, FR-008, FR-009, FR-010, FR-011, FR-014, FR-015, FR-027.

## Label trigger

### Inbound event

GitHub webhook event types: `issues.labeled`, `pull_request.labeled`. Signed payload already verified by `@octokit/webhooks` before the handler is called.

### Preconditions

1. Payload `label.name` matches `^bot:[a-z]+$`.
2. Payload `sender.login` is in the configured `ALLOWED_OWNERS` allowlist (existing guard — reused verbatim).

If either precondition fails, the event is silently ignored (same behaviour as existing routing).

### Steps

1. **Resolve registry entry.** Look up the applied label in `workflows.registry`. If no entry matches the label, the event is outside scope — log and ignore.
2. **Context validation.** If the entry's `context` does not include the event's target type (`issue` vs `pr`), post a short refusal comment and return HTTP 200. Do not dispatch.
3. **Prior-output check (FR-004 for `implement`, etc.).** If the entry has `requiresPrior`, query `workflow_runs` for a `succeeded` row matching `(workflow_name=prior, target=item)`. If missing, post a refusal comment and return. No dispatch. Running this before the mutex step ensures a refusal does not strip unrelated `bot:*` labels from the item.
4. **Enforce label mutex (FR-014).** Remove every other `bot:*` label currently on the item. Log each removal with reason `bot-label-mutex`.
5. **Idempotency guard (FR-011).** Attempt to `INSERT INTO workflow_runs (workflow_name, target_*, status='queued', delivery_id)` . If the partial unique index rejects the insert, an in-flight run already exists — log and return 200 without enqueueing.
6. **Enqueue.** Publish a job to the existing Valkey queue with payload `{ workflowRunId, workflowName, target, parentRunId?: null, parentStepIndex?: null, deliveryId }`.
7. **Return 200.** Webhook handler is done. Execution proceeds asynchronously in the daemon (FR-027).

## Comment trigger

### Inbound event

`issue_comment.created`, `pull_request_review_comment.created`. Only comments whose body mentions `@chrisleekr-bot` (existing trigger detection in `src/core/trigger.ts`) are considered.

### Steps

1. **Run intent classifier.** Call `workflows.intentClassifier.classify(comment.body)`. Returns `{ workflow, confidence, rationale }`.
2. **Apply threshold (FR-009).** If `confidence < INTENT_CONFIDENCE_THRESHOLD` (default 0.75) or the classifier returns `clarify`, post a single clarifying-question comment and stop.
3. **Handle unsupported (FR-010).** If the classifier returns `unsupported`, post a short refusal comment and stop.
4. **Dispatch as label-equivalent.** From step 3 onward, treat the selected workflow exactly as if the corresponding `bot:*` label had been applied by the comment author — the same context validation, mutex, prior-output check, idempotency insert, and enqueue from "Label trigger" apply.

The mutex step also runs for comment-originated dispatches so a stray `bot:plan` label from an earlier manual action is cleared when a comment asks for `bot:ship`.

## Non-goals for this contract

- Rate limiting: existing concurrency guard applies unchanged (Constitution III).
- Re-run requested by maintainer: out of scope for v1 — noted in FR-011 as "unless the maintainer explicitly requests a re-run" but the re-run mechanism itself (comment command, label reset, etc.) is deferred to a later spec.
