/**
 * Public surface of the workflow registry for modules that must stay
 * decoupled from the in-process registry constant — daemon job router,
 * orchestrator hand-off logic, webhook event handlers.
 *
 * Those modules need the type shapes but MUST NOT import the parsed
 * registry itself, because importing `../workflows/registry` pulls in
 * every handler's transitive dependency graph (git CLI, MCP servers,
 * etc.) and that breaks dependency layering.
 */

import type { WorkflowName } from "../workflows/registry";

export type {
  HandlerResult,
  Registry,
  RegistryEntry,
  WorkflowContext,
  WorkflowHandler,
  WorkflowName,
  WorkflowRunContext,
} from "../workflows/registry";

/**
 * Reference to a `workflow_runs` row that piggybacks on the existing job
 * queue and WebSocket payload. The daemon branches on the presence of this
 * field to route to the workflow handler path instead of the legacy pipeline.
 *
 * **`workflow_runs.context_json.shipIntentId` convention** (ship-iteration-wiring):
 * When a ship-driven iteration inserts a `workflow_runs` row, it MUST embed
 * `{ shipIntentId: <uuid> }` inside `context_json`. This is a JSON convention,
 * not a column — it lets the orchestrator's completion cascade
 * (`handleWorkflowRunCompletion` in `src/workflows/orchestrator.ts`) early-wake
 * the originating intent via `ZADD ship:tickle 0 <intent_id>` without growing
 * `WorkflowRunRef` itself. The daemon does not need to read `shipIntentId` —
 * only the server-side cascade does.
 */
export interface WorkflowRunRef {
  readonly runId: string;
  readonly workflowName: WorkflowName;
  readonly parentRunId?: string;
  readonly parentStepIndex?: number;
}
