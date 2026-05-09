/**
 * Body templates for the chat-thread executor's proposal comments.
 *
 * UX-critical invariants:
 *
 * 1. The text MUST tell the user EXACTLY which comment to react on.
 *    GitHub does not fire webhooks for reactions, so a stray 👍 on a
 *    different bot reply (a Q&A answer, an acknowledgement) is silently
 *    ignored — the user has to know that.
 *
 * 2. The TTL must be visible. The proposal-poller expires awaiting
 *    rows after `CHAT_THREAD_PROPOSAL_TTL_HOURS`; a reaction arriving
 *    after expiry is logged-but-ignored and the user gets a
 *    "proposal expired" reply.
 *
 * 3. The phrasing acknowledges that reactions take a moment to
 *    register — sets expectation that the bot will pick them up "next
 *    time you interact with this PR" via the piggyback poll, even
 *    though the periodic scanner will also catch them.
 *
 * No HTML markers in the body itself — the proposal id lives on the
 * `chat_proposals` row, not in the comment body. This keeps the
 * comment human-readable and prevents an attacker from forging a
 * marker by editing a different comment.
 */

import type { ProposalKind } from "../db/queries/proposals-store";

export interface ProposalCommentInput {
  readonly verbInPlainEnglish: string;
  readonly rationale?: string;
  readonly ttlHours: number;
  readonly kind: ProposalKind;
}

/**
 * Render the proposal comment body. Caller posts via
 * `safePostToGitHub({ source: "agent", ... })` from the chat-thread
 * executor.
 */
export function renderProposalComment(input: ProposalCommentInput): string {
  const lines: string[] = [];
  lines.push(`I think you want me to **${input.verbInPlainEnglish}**.`);
  lines.push("");
  if (input.rationale !== undefined && input.rationale.length > 0) {
    lines.push(`_Rationale_: ${input.rationale}`);
    lines.push("");
  }
  lines.push(
    `React 👍 **on this comment** within ${String(input.ttlHours)}h to confirm. ` +
      `(GitHub doesn't notify me of reactions, so I'll check on the next webhook ` +
      `for this ${input.kind.startsWith("workflow:") ? "PR/issue" : "thread"} or ` +
      `via the periodic scanner.) Reply "no" or react with 👎 to decline.`,
  );
  return lines.join("\n");
}

/**
 * Render the body for "your edit invalidated my prior proposal". Used
 * when a webhook for `comment.edited` arrives on a comment that was
 * the prompting comment for an awaiting proposal.
 */
export function renderProposalSupersededByEdit(): string {
  return (
    "_You edited the comment that prompted my prior proposal — " +
    "the proposal no longer applies. Re-ask if you'd like a fresh take._"
  );
}

/**
 * Render the body for "your reaction came too late". Used when the
 * reaction-poller spots a 👍 on an expired proposal. Caller passes
 * the configured TTL so the message stays accurate when
 * `chatThreadProposalTtlHours` is overridden.
 */
export function renderProposalExpired(ttlHours: number): string {
  return `_The proposal expired (${String(ttlHours)}h TTL). Re-ask in a fresh comment and I'll re-evaluate._`;
}

/**
 * Render the body for "I'm still waiting on your 👍 from the prior
 * proposal". Used when the user replies in a thread but their reply
 * isn't a clear approval/decline/replace — the bot nudges them.
 */
export function renderProposalNudge(verbInPlainEnglish: string): string {
  return (
    `_I'm still waiting on a 👍 reaction on my prior proposal to ` +
    `**${verbInPlainEnglish}** — your reply didn't read as approve or ` +
    `decline. Reply "no" to drop it._`
  );
}
