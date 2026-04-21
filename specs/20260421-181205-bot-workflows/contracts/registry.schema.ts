/**
 * Contract: Workflow Registry shape
 *
 * This file is a specification artefact. The real module at
 * `src/workflows/registry.ts` MUST export types and a parsed registry that
 * conform to this schema. Changing this contract requires a spec update.
 *
 * FR mapping: FR-022 (registry fields), FR-023 (single source), FR-024
 * (adding a workflow = 1 entry + 1 handler + 1 doc section).
 */

import { z } from "zod";

export const WorkflowNameSchema = z.enum(["triage", "plan", "implement", "review", "ship"]);
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;

export const WorkflowContextSchema = z.enum(["issue", "pr", "both"]);
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

/**
 * Result returned by every handler. The orchestrator consumes `status` to
 * decide whether to hand off to the next step (FR-028) or fail the composite
 * (FR-029). `state` is merged into `workflow_runs.state` in the same
 * transaction as the status flip.
 */
export const HandlerResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), state: z.unknown() }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
    state: z.unknown().optional(),
  }),
]);
export type HandlerResult = z.infer<typeof HandlerResultSchema>;

/**
 * Context handed to every handler. Constructed by the daemon after claiming
 * a job, BEFORE the handler runs. Contains everything a handler needs; the
 * handler MUST NOT reach into orchestrator or webhook internals.
 */
export interface WorkflowRunContext {
  readonly runId: string;
  readonly workflowName: WorkflowName;
  readonly target: {
    readonly type: "issue" | "pr";
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
  readonly parent?: {
    readonly runId: string;
    readonly stepIndex: number;
  };
  readonly logger: import("pino").Logger;
  readonly octokit: import("octokit").Octokit;
  readonly deliveryId: string | null;
  /** Writes workflow-specific state + mirrors it to the tracking comment. */
  readonly setState: (state: unknown, humanMessage: string) => Promise<void>;
}

export type WorkflowHandler = (ctx: WorkflowRunContext) => Promise<HandlerResult>;

/**
 * A single registry entry. All dispatcher, classifier, and docs logic MUST
 * read from the array of these; no hard-coded list of workflow names is
 * permitted elsewhere (FR-023).
 */
export const RegistryEntrySchema = z.object({
  name: WorkflowNameSchema,
  /** MUST match `^bot:[a-z]+$`. The dispatcher greps on this. */
  label: z.string().regex(/^bot:[a-z]+$/),
  /** Which item types this workflow may run against. */
  context: WorkflowContextSchema,
  /**
   * If non-null, the workflow refuses to run against an item that has no
   * terminal (succeeded) run of the named prior workflow. Applies only to
   * atomic workflows; composite workflows set this to null and express
   * their internal dependency structure via `steps`.
   */
  requiresPrior: WorkflowNameSchema.nullable(),
  /**
   * Ordered list of other workflow names to run sequentially. Empty for
   * atomic workflows. When non-empty, the entry is a composite and
   * `requiresPrior` MUST be null.
   */
  steps: z.array(WorkflowNameSchema),
  /** Direct import reference — NOT a string. */
  handler: z.custom<WorkflowHandler>((v) => typeof v === "function", {
    message: "handler must be a function reference",
  }),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistrySchema = z
  .array(RegistryEntrySchema)
  .refine((entries) => new Set(entries.map((e) => e.name)).size === entries.length, {
    message: "workflow names must be unique",
  })
  .refine((entries) => new Set(entries.map((e) => e.label)).size === entries.length, {
    message: "labels must be unique",
  })
  .refine(
    (entries) => {
      const names = new Set(entries.map((e) => e.name));
      return entries.every((e) => e.steps.every((s) => names.has(s)));
    },
    { message: "every step must reference an existing workflow name" },
  )
  .refine((entries) => entries.every((e) => e.steps.length === 0 || e.requiresPrior === null), {
    message: "composite workflows (non-empty steps) must have requiresPrior === null",
  });
export type Registry = z.infer<typeof RegistrySchema>;
