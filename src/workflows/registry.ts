import type { Octokit } from "octokit";
import type pino from "pino";
import { z } from "zod";

import { handler as implementHandler } from "./handlers/implement";
import { handler as planHandler } from "./handlers/plan";
import { handler as reviewHandler } from "./handlers/review";
import { handler as shipHandler } from "./handlers/ship";
import { handler as triageHandler } from "./handlers/triage";

export const WorkflowNameSchema = z.enum(["triage", "plan", "implement", "review", "ship"]);
export type WorkflowName = z.infer<typeof WorkflowNameSchema>;

export const WorkflowContextSchema = z.enum(["issue", "pr", "both"]);
export type WorkflowContext = z.infer<typeof WorkflowContextSchema>;

/**
 * `humanMessage` lets the handler supply the exact body the executor should
 * render into the tracking comment alongside the terminal status header.
 * When omitted, the executor falls back to a generic "<workflow> <status>"
 * line. Handlers that already wrote a rich message via `ctx.setState` during
 * execution should repeat it here so the final replace-write preserves it.
 */
export const HandlerResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    state: z.unknown(),
    humanMessage: z.string().min(1).optional(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().min(1),
    state: z.unknown().optional(),
    humanMessage: z.string().min(1).optional(),
  }),
]);
export type HandlerResult = z.infer<typeof HandlerResultSchema>;

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
  readonly logger: pino.Logger;
  readonly octokit: Octokit;
  readonly deliveryId: string | null;
  readonly setState: (state: unknown, humanMessage: string) => Promise<void>;
}

export type WorkflowHandler = (ctx: WorkflowRunContext) => Promise<HandlerResult>;

export const RegistryEntrySchema = z.object({
  name: WorkflowNameSchema,
  label: z.string().regex(/^bot:[a-z]+$/),
  context: WorkflowContextSchema,
  requiresPrior: WorkflowNameSchema.nullable(),
  steps: z.array(WorkflowNameSchema),
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

/**
 * The sole authoritative list of bot workflows. FR-023 — no other module may
 * hard-code workflow names. Adding a workflow is one entry here plus one
 * handler file plus one docs section (FR-024). Parsed at module load so a
 * mistyped entry fails the process at boot, not mid-flight.
 */
const rawRegistry: RegistryEntry[] = [
  {
    name: "triage",
    label: "bot:triage",
    context: "issue",
    requiresPrior: null,
    steps: [],
    handler: triageHandler,
  },
  {
    name: "plan",
    label: "bot:plan",
    context: "issue",
    requiresPrior: "triage",
    steps: [],
    handler: planHandler,
  },
  {
    name: "implement",
    label: "bot:implement",
    context: "issue",
    requiresPrior: "plan",
    steps: [],
    handler: implementHandler,
  },
  {
    name: "review",
    label: "bot:review",
    context: "pr",
    requiresPrior: null,
    steps: [],
    handler: reviewHandler,
  },
  {
    name: "ship",
    label: "bot:ship",
    context: "issue",
    requiresPrior: null,
    steps: ["triage", "plan", "implement", "review"],
    handler: shipHandler,
  },
];

export const registry: Registry = RegistrySchema.parse(rawRegistry);

export function getByName(name: WorkflowName): RegistryEntry {
  const entry = registry.find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`Workflow registry entry not found: ${name}`);
  }
  return entry;
}

export function getByLabel(label: string): RegistryEntry | undefined {
  return registry.find((e) => e.label === label);
}
