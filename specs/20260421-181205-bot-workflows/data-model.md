# Phase 1 Data Model: Definitive Bot Workflows

Two artefacts live in this layer: the **workflow registry** (in-process TypeScript constant) and the **`workflow_runs` table** (PostgreSQL). The tracking comment is a projection of the row, not a separate entity.

## Entity: Workflow registry (in-process)

Authoritative TypeScript constant in `src/workflows/registry.ts`, shape enforced by a Zod schema at import time.

### Zod schema (conceptual)

```ts
const WorkflowName = z.enum(["triage", "plan", "implement", "review", "ship"]);

const RegistryEntry = z.object({
  name: WorkflowName,
  label: z.string().regex(/^bot:[a-z]+$/),
  context: z.enum(["issue", "pr", "both"]),
  requiresPrior: WorkflowName.nullable(), // null = no prior output required
  steps: z.array(WorkflowName), // empty for atomic workflows
  handler: z.custom<WorkflowHandler>(), // direct import reference
});

const Registry = z
  .array(RegistryEntry)
  .refine((entries) => new Set(entries.map((e) => e.name)).size === entries.length, {
    message: "workflow names must be unique",
  });
```

### Concrete entries

| name        | label           | context | requiresPrior | steps                                    | handler (import)                  |
| ----------- | --------------- | ------- | ------------- | ---------------------------------------- | --------------------------------- |
| `triage`    | `bot:triage`    | `issue` | `null`        | `[]`                                     | `./handlers/triage.ts#handler`    |
| `plan`      | `bot:plan`      | `issue` | `triage`      | `[]`                                     | `./handlers/plan.ts#handler`      |
| `implement` | `bot:implement` | `issue` | `plan`        | `[]`                                     | `./handlers/implement.ts#handler` |
| `review`    | `bot:review`    | `pr`    | `null`        | `[]`                                     | `./handlers/review.ts#handler`    |
| `ship`      | `bot:ship`      | `issue` | `null`        | `['triage','plan','implement','review']` | `./handlers/ship.ts#handler`      |

### Validation rules

- `label` MUST be unique across entries (checked by `.refine` alongside `name`).
- `steps` entries MUST reference names that exist in the same registry (checked at import).
- If `steps` is non-empty, `requiresPrior` MUST be `null` (a composite workflow owns its own preconditions — individual steps carry their own `requiresPrior`).
- Handler signature is the same for every entry: `(ctx: WorkflowRunContext) => Promise<HandlerResult>`, where `HandlerResult` is a discriminated union: `{ status: 'succeeded'; state: unknown }` | `{ status: 'failed'; reason: string; state?: unknown }`.

## Entity: `workflow_runs` (PostgreSQL)

One table, mutable row per run, added by migration `src/db/migrations/005_workflow_runs.sql`.

### Columns

| Column                | Type        | Nullable | Notes                                                                                                     |
| --------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `id`                  | UUID        | NO       | Primary key. Generated with `gen_random_uuid()`.                                                          |
| `workflow_name`       | TEXT        | NO       | One of the five names. Kept as TEXT not ENUM to avoid migrations when workflows are added (FR-025).       |
| `target_type`         | TEXT        | NO       | `'issue'` or `'pr'`. `CHECK (target_type IN ('issue','pr'))`.                                             |
| `target_owner`        | TEXT        | NO       |                                                                                                           |
| `target_repo`         | TEXT        | NO       |                                                                                                           |
| `target_number`       | INT         | NO       | Issue or PR number.                                                                                       |
| `parent_run_id`       | UUID        | YES      | `REFERENCES workflow_runs(id) ON DELETE CASCADE`. NULL for top-level runs (label- or comment-originated). |
| `parent_step_index`   | INT         | YES      | Index into the parent registry entry's `steps`. NOT NULL iff `parent_run_id` IS NOT NULL. `CHECK`.        |
| `status`              | TEXT        | NO       | `'queued' \| 'running' \| 'succeeded' \| 'failed'`. `CHECK`.                                              |
| `state`               | JSONB       | NO       | DEFAULT `'{}'::jsonb`. Workflow-specific fields; no schema migration to add fields.                       |
| `tracking_comment_id` | BIGINT      | YES      | GitHub comment id of the tracking comment; NULL before first post.                                        |
| `delivery_id`         | TEXT        | YES      | `X-GitHub-Delivery` of the event that seeded this run, for request tracing.                               |
| `created_at`          | TIMESTAMPTZ | NO       | DEFAULT `now()`.                                                                                          |
| `updated_at`          | TIMESTAMPTZ | NO       | DEFAULT `now()`. Updated on every status/state write via `ON UPDATE` trigger or app-level bump.           |

### Indexes

1. `PRIMARY KEY (id)`.
2. `UNIQUE INDEX idx_workflow_runs_inflight ON workflow_runs (workflow_name, target_owner, target_repo, target_number) WHERE status IN ('queued','running')` — enforces FR-011 idempotency: a second label application cannot open a second in-flight run for the same (workflow, item). Terminal rows do not block re-runs.
3. `INDEX idx_workflow_runs_target ON workflow_runs (target_owner, target_repo, target_number)` — lookup on resume (`bot:ship` re-applied → "what's the latest run for this issue?").
4. `INDEX idx_workflow_runs_parent ON workflow_runs (parent_run_id) WHERE parent_run_id IS NOT NULL` — locating children of a composite for "next step" computation.

### Constraints

- `CHECK ((parent_run_id IS NULL) = (parent_step_index IS NULL))` — both or neither.
- `CHECK (target_number > 0)`.

### State transitions

```text
   (new)
     │
     ▼
  queued ──────► running ──────► succeeded
                    │                │
                    ▼                │
                 failed ◄────────────┘  (only if a hand-off triggers a cascade failure on parent)
```

- `queued` → row exists; job is in Valkey but not yet claimed.
- `queued` → `running` transition happens when the daemon claims the job and before the handler starts.
- `running` → `succeeded` / `failed` is the handler's terminal write. Both include a `state` update in the same SQL statement.
- `running` → `failed` may additionally propagate to the parent composite row per FR-029.

### Example rows (illustrative, not seed data)

#### 1. Top-level `bot:triage` run on issue #42

```json
{
  "id": "…uuid-a…",
  "workflow_name": "triage",
  "target_type": "issue",
  "target_owner": "chrisleekr",
  "target_repo": "github-app-playground",
  "target_number": 42,
  "parent_run_id": null,
  "parent_step_index": null,
  "status": "succeeded",
  "state": {
    "verdict": "bug",
    "recommendedNext": "plan",
    "rationale": "stack trace suggests a null deref"
  },
  "tracking_comment_id": 9876543210
}
```

#### 2. `bot:ship` on issue #42 — parent row

```json
{
  "id": "…uuid-b…",
  "workflow_name": "ship",
  "status": "running",
  "state": { "currentStepIndex": 2, "stepRuns": ["…uuid-c…", "…uuid-d…", "…uuid-e…"] }
}
```

#### 3. Child step row (step index 2 → `implement`)

```json
{
  "id": "…uuid-e…",
  "workflow_name": "implement",
  "parent_run_id": "…uuid-b…",
  "parent_step_index": 2,
  "status": "running",
  "state": { "branch": "bot/issue-42-impl" }
}
```

## Relationship summary

```text
registry (in-process, read-only)
    │
    │ supplies WorkflowName + steps[]
    ▼
workflow_runs (Postgres, mutable)
    │   ▲
    │   │ parent_run_id (self-reference, FK)
    ▼   │
tracking comment (GitHub, projection — no FK in our DB, only comment_id stored)
```

The registry is code; `workflow_runs` is data; the tracking comment is a rendered view. The registry is never written at runtime; `workflow_runs` is written only by handlers and the orchestrator hand-off path.
