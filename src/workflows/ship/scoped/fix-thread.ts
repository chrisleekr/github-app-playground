/**
 * `bot:fix-thread` scoped command (FR-029). Applies a mechanical fix
 * requested in a review thread, replies with the resulting commit SHA
 * (FR-005), and resolves the thread (via the MCP `resolve-review-thread`
 * server from T029). Stateless one-shot: no `ship_intents` row, no
 * tracking comment.
 *
 * **Conservatism (FR-004):** the bot refuses to act on threads that
 * appear to request a design discussion or non-mechanical change. The
 * heuristic is a simple keyword scan; ambiguous threads default to
 * refusal so the maintainer decides.
 *
 * Eligible only on the `review-comment` event surface: the trigger
 * MUST originate from a `pull_request_review_comment` event so a
 * concrete `thread_id` is available.
 *
 * The actual git operations (clone, fix, push) are delegated to the
 * caller-supplied `applyMechanicalFix` callback so the orchestration
 * logic in this module is fully unit-testable without a real working
 * tree. The destructive-action guards from T046a apply to the
 * implementation of that callback (force-push and history rewrite are
 * forbidden).
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { logger as rootLogger } from "../../../logger";
import { safePostToGitHub } from "../../../utils/github-output-guard";
import { formatReply } from "../../format-reply";

const DESIGN_DISCUSSION_PHRASES = [
  "let's discuss",
  "lets discuss",
  "redesign",
  "different approach",
  "rethink",
  "out of scope",
  "needs design",
  "architectural",
];

export function isDesignDiscussion(threadBody: string): boolean {
  const lowered = threadBody.toLowerCase();
  return DESIGN_DISCUSSION_PHRASES.some((phrase) => lowered.includes(phrase));
}

export interface FixThreadContext {
  readonly path: string;
  readonly line_range: string;
  readonly diff_hunk: string;
  readonly thread_body: string;
}

export interface ApplyMechanicalFixResult {
  readonly applied: boolean;
  readonly commit_sha?: string;
  readonly skip_reason?: string;
  /**
   * One-paragraph explanation of WHY the fix was applied (or what was
   * deferred). Surfaced verbatim in the CR-style reply body so the
   * reviewer can read the reasoning without opening the commit.
   * Optional for back-compat; falls back to a generic line.
   */
  readonly reasoning?: string;
}

export interface RunFixThreadInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly comment_id: number;
  readonly thread_node_id: string;
  readonly thread: FixThreadContext;
  readonly applyMechanicalFix: (ctx: FixThreadContext) => Promise<ApplyMechanicalFixResult>;
  /** MCP `resolve-review-thread` server callback (T029). */
  readonly resolveThread: (input: { thread_id: string }) => Promise<void>;
  readonly log?: Logger;
}

export type FixThreadOutcome =
  | { readonly kind: "applied"; readonly commit_sha: string; readonly reply_id: number }
  | { readonly kind: "design-discussion"; readonly reply_id: number }
  | { readonly kind: "skipped"; readonly reply_id: number; readonly reason: string };

export async function runFixThread(input: RunFixThreadInput): Promise<FixThreadOutcome> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.fix_thread",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.pr_number,
    comment_id: input.comment_id,
  });

  // All reply paths below route through this helper so the output secret
  // guard (regex + LLM scanner) runs once, in one place. Reply bodies may
  // include agent-supplied `result.reasoning` text, flag as "agent" source.
  const postReply = async (body: string, callsite: string): Promise<number> => {
    const guarded = await safePostToGitHub({
      body,
      source: "agent",
      callsite,
      log,
      post: (cleanBody) =>
        input.octokit.rest.pulls.createReplyForReviewComment({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
          comment_id: input.comment_id,
          body: cleanBody,
        }),
    });
    if (!guarded.posted || guarded.result === undefined) {
      throw new Error(
        `${callsite}: post skipped after secret redaction (matchCount=${guarded.matchCount})`,
      );
    }
    return guarded.result.data.id;
  };

  // Conservatism gate (FR-004), refuse design-discussion requests.
  if (isDesignDiscussion(input.thread.thread_body)) {
    const body = formatReply({
      status: "_💬 Design discussion_",
      title: "Refusing to push a mechanical fix.",
      reasoning:
        "This thread reads like a design discussion (FR-004). The bot only applies mechanical fixes; design changes are a maintainer call. Please weigh in before this becomes a code change.",
    });
    const reply_id = await postReply(body, "ship.scoped.fix_thread.design-discussion");
    log.info({ reply_id }, "fix_thread refused (design-discussion)");
    return { kind: "design-discussion", reply_id };
  }

  const result = await input.applyMechanicalFix(input.thread);

  if (!result.applied) {
    const reason = result.skip_reason ?? "no actionable mechanical change identified";
    const body = formatReply({
      status: "_⏭️ Skipped_",
      title: "No mechanical fix applied.",
      reasoning: `I couldn't apply a mechanical fix here, ${reason}.`,
    });
    const reply_id = await postReply(body, "ship.scoped.fix_thread.skipped");
    log.info({ reply_id, reason }, "fix_thread skipped");
    return { kind: "skipped", reply_id, reason };
  }

  if (result.commit_sha === undefined) {
    // Partial success, callback claimed it applied a fix but withheld
    // the SHA. Surfaced at warn so the buggy callback is discoverable
    // in logs; behaviour matches the no-applied path otherwise.
    const reason =
      result.skip_reason ?? "applyMechanicalFix returned applied=true without commit_sha";
    const body = formatReply({
      status: "_⏭️ Skipped_",
      title: "No mechanical fix applied.",
      reasoning: `I couldn't apply a mechanical fix here, ${reason}.`,
    });
    const reply_id = await postReply(body, "ship.scoped.fix_thread.skipped-partial");
    log.warn({ reply_id, reason }, "fix_thread skipped (partial success)");
    return { kind: "skipped", reply_id, reason };
  }

  const trimmedReasoning = result.reasoning?.trim() ?? "";
  const body = formatReply({
    status: "_✅ Fix applied_",
    meta: `, commit \`${result.commit_sha}\``,
    title: "Mechanical fix pushed.",
    reasoning:
      trimmedReasoning.length > 0 ? trimmedReasoning : "See the linked commit for the change.",
  });
  const reply_id = await postReply(body, "ship.scoped.fix_thread.applied");

  // Best-effort thread resolution (FR-005). A failure here does not undo
  // the commit: the reply with the SHA already documents the fix.
  try {
    await input.resolveThread({ thread_id: input.thread_node_id });
  } catch (err) {
    log.warn({ err }, "fix_thread reply posted but thread resolution failed");
  }

  log.info({ reply_id, commit_sha: result.commit_sha }, "fix_thread applied");
  return { kind: "applied", commit_sha: result.commit_sha, reply_id };
}
