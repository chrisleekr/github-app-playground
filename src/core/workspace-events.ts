/**
 * Canonical pino log-field schema for the `workspace.*` event family (issue #243).
 *
 * The success-path cleanup is already covered by `pipeline.stage` (issue #166,
 * `stage=workspace.cleanup`) and the TTL reaper by `workspace.sweep`
 * (`src/core/workspace-sweep.ts#sweepStaleWorkspaces`). This family is the
 * observability companion to issue #221: it makes the *non-success* paths that
 * touch the workspace triple (`<workDir>`, `<workDir>.cred.sh`,
 * `<workDir>-artifacts`) greppable so an operator seeing disk pressure or a
 * token-leak alert can attribute reclamation to a cause (clone failure, job
 * cancel, daemon exit) instead of only an aggregate sweep count.
 *
 * Mirrors `src/core/log-fields.ts` and `src/webhook/idempotency-log-fields.ts`:
 * a `.strict()` Zod shape per outcome pins each event so an emitter that adds an
 * unpinned field or mistypes one trips the co-located test. Emitters log plain
 * objects via `log.info` / `log.warn`; the schema is the drift-prevention
 * contract, not a runtime validator on the hot path.
 *
 * Security: `workDir` is a process-local temp path (safe to log). The
 * authenticated clone URL embeds the install token and is NEVER logged; emit the
 * `owner/repo` slug and branch instead. Error text is routed through
 * `redactErrorMessage` (`src/utils/log-redaction.ts#redactErrorMessage`) before
 * landing on an `err` field. New metric-style fields are snake_case;
 * `workDir` / `baseBranch` / `headBranch` / `jobIds` stay camelCase to match the
 * established workspace-sweep and child-logger field bindings.
 */
import { z } from "zod";

export const WORKSPACE_LOG_EVENTS = {
  cloneStarted: "workspace.clone.started",
  cloneCompleted: "workspace.clone.completed",
  cloneFailed: "workspace.clone.failed",
  baseBranchFetched: "workspace.base_branch.fetched",
  baseBranchFetchFailed: "workspace.base_branch.fetch_failed",
  cleanupCompleted: "workspace.cleanup.completed",
  cleanupFailed: "workspace.cleanup.failed",
  cleanupExit: "workspace.cleanup.exit",
  cleanupCancel: "workspace.cleanup.cancel",
} as const;

/** Removal target inside the workspace triple; pins the `cleanup.failed` discriminator. */
export const WORKSPACE_CLEANUP_TARGETS = ["clone", "helper", "artifacts"] as const;

const repo = z.string().min(1);
const branch = z.string().min(1);

export const WorkspaceLogFieldsSchema = z.union([
  /** Info: `git clone` is about to run. `repo` is the slug, never the token URL. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cloneStarted),
    repo,
    branch,
    depth: z.number().int().positive(),
  }),
  /** Info: clone + git config done. `clone_ms` is the `git clone` wall-clock. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cloneCompleted),
    repo,
    branch,
    clone_ms: z.number().int().nonnegative(),
  }),
  /** Warn: clone threw; the partial workspace is best-effort removed. `err` is redacted text. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cloneFailed),
    repo,
    branch,
    err: z.string(),
  }),
  /** Info: the divergent PR base ref was fetched so `origin/<base>` resolves. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.baseBranchFetched),
    baseBranch: branch,
    headBranch: branch,
  }),
  /** Warn: base-ref fetch failed; agent diff/rebase may widen to the shallow boundary. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.baseBranchFetchFailed),
    baseBranch: branch,
    headBranch: branch,
    err: z.string(),
  }),
  /** Info: a workspace triple was fully reclaimed (all three rm calls succeeded). */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cleanupCompleted),
    workDir: z.string().min(1),
  }),
  /** Warn: one rm inside the triple threw; `target` names which path. `err` is redacted. */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cleanupFailed),
    workDir: z.string().min(1),
    target: z.enum(WORKSPACE_CLEANUP_TARGETS),
    err: z.string(),
  }),
  /** Warn: daemon exit handler is reclaiming N in-flight workspaces (crashloop fingerprint). */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cleanupExit),
    count: z.number().int().nonnegative(),
    jobIds: z.array(z.string()),
  }),
  /** Info: a cancelled job's workspace is being reclaimed (paired with daemon.job.cancelled). */
  z.strictObject({
    event: z.literal(WORKSPACE_LOG_EVENTS.cleanupCancel),
    workDir: z.string().min(1),
  }),
]);

export type WorkspaceLogFields = z.infer<typeof WorkspaceLogFieldsSchema>;
