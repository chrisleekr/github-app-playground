# WebSocket Message Contract Additions

**Feature**: [spec.md](../spec.md) · **Plan**: [plan.md](../plan.md) · **Source**: `src/shared/ws-messages.ts`

This document specifies the **additions** to the WebSocket message schema between the orchestrator (webhook server) and the daemon. No existing message kinds are modified.

---

## New message kinds (server → daemon)

### `scoped-job-offer`

Sent when the orchestrator wants to dispatch a scoped command job to a daemon. The daemon replies with `scoped-job-accept` or `scoped-job-reject` using the existing offer/accept/reject pattern.

```ts
{
  kind: "scoped-job-offer",
  offerId: string,                  // UUID; daemon echoes in accept/reject
  jobKind:
    | "scoped-rebase"
    | "scoped-fix-thread"
    | "scoped-explain-thread"
    | "scoped-open-pr",
  deliveryId: string,               // GitHub X-GitHub-Delivery; for log correlation
  installationId: number,
  owner: string,
  repo: string,
  prNumber?: number,                // present for rebase/fix-thread/explain-thread
  issueNumber?: number,             // present for open-pr (issue-driven)
  threadRef?: {                     // present for fix-thread/explain-thread
    threadId: string,               // GraphQL node id
    commentId: number,              // REST id of the trigger comment
    filePath: string,
    startLine: number,
    endLine: number,
  },
  triggerCommentId: number,         // REST id of the maintainer comment that started this
  enqueuedAt: number,               // epoch ms
}
```

### `scoped-job-completion`

Sent by the daemon after the executor finishes (success or failure). Mirrors the existing workflow-run completion shape.

```ts
{
  kind: "scoped-job-completion",
  offerId: string,
  jobKind: /* same union as offer */,
  status: "succeeded" | "failed" | "halted",
  // For succeeded scoped-rebase:
  rebaseOutcome?:
    | { result: "up-to-date"; commentId: number }
    | { result: "merged"; commentId: number; mergeCommitSha: string }
    | { result: "conflict"; commentId: number; conflictPaths: string[] }
    | { result: "closed"; commentId: number },
  // For succeeded scoped-fix-thread / scoped-open-pr:
  pushedCommitSha?: string,
  threadReplyId?: number,           // fix-thread / explain-thread
  newPrNumber?: number,             // open-pr only
  // For halted/failed:
  reason?: string,                  // human-readable; goes into the user-visible reply
  // Cost reporting (existing pattern):
  costUsd?: number,
  durationMs?: number,
}
```

---

## Validation

- All new payloads MUST be parsed via Zod **discriminated unions keyed on `jobKind`** at both ends (server-side serialization and daemon-side parse on receive). The discriminator MUST live at the schema level, not in runtime branching after a permissive parse — this guarantees that missing required fields per kind (e.g., absent `threadRef` for `scoped-fix-thread`, absent `issueNumber` for `scoped-open-pr`) fail at the WS boundary, not deeper in the executor.
- Unknown `jobKind` values MUST be rejected with `scoped-job-reject` ("unsupported job kind") rather than silently dropped — daemons running an older image must signal capability mismatch explicitly.

---

## Backward compatibility

- All new kinds are additive. Existing legacy and workflow-run messages remain unchanged.
- Daemons running a previous image that does not support these kinds MUST `scoped-job-reject` with `reason: "unsupported"` so the orchestrator can re-offer the job to a capable daemon (existing offer/reject pattern handles this).

---

## Reject taxonomy (reused)

Existing reject reasons (`busy`, `incompatible`, `shutting-down`) apply unchanged. One new reason is added for capability mismatch on scoped jobs:

- `scoped-kind-unsupported` — daemon image does not understand this `jobKind`.
