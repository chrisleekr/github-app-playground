/**
 * `bot:explain-thread` scoped command (FR-030). Posts a single
 * explanatory reply on a review thread without committing or
 * resolving the thread. Stateless one-shot.
 *
 * Eligible only on the `review-comment` event surface — the trigger
 * MUST originate from a `pull_request_review_comment` event so a
 * concrete `thread_id` is available.
 */

import type { Octokit } from "octokit";
import type { Logger } from "pino";

import { logger as rootLogger } from "../../../logger";

export const EXPLAIN_THREAD_SYSTEM_PROMPT = `You explain code in the context of a GitHub review thread.
The reader is a reviewer who asked for clarification on a specific code region.

Return Markdown in this EXACT three-block layout (CodeRabbit-style):

  _💡 Explanation_

  **<one-sentence summary of what the code does>**

  <prose: short bulleted list of mechanics worth noting, then any caveats
  (edge cases, invariants, gotchas) on a new paragraph>

Rules:
  - The first line MUST be exactly "_💡 Explanation_" (no extra text).
  - The second line MUST be blank.
  - The third line MUST be a bold one-sentence summary wrapped in **...**.
  - The fourth line MUST be blank.
  - Body follows; bullets and short paragraphs only.
  - Be precise; do NOT speculate beyond the code that was provided.`;

export interface ThreadContext {
  readonly path: string;
  readonly line_range: string;
  readonly diff_hunk: string;
  readonly code_snippet: string;
  /**
   * The reviewer's question — the body of the top-level review comment
   * starting the thread, plus any follow-up replies, joined by blank
   * lines. Required so the LLM has the actual ask, not just the code.
   * Empty string is permitted for callers that have no thread text yet
   * (e.g., explain triggered before the comment body is fetched).
   */
  readonly thread_body: string;
}

export interface RunExplainThreadInput {
  readonly octokit: Pick<Octokit, "rest">;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  /** Top-level review comment id starting the thread. */
  readonly comment_id: number;
  /**
   * Caller-resolved code context for the thread. The webhook payload
   * carries `path` and `diff_hunk`; the reactor that invokes this
   * command resolves the line range and pulls a code snippet from the
   * cloned working tree.
   */
  readonly thread: ThreadContext;
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  readonly log?: Logger;
}

export async function runExplainThread(
  input: RunExplainThreadInput,
): Promise<{ reply_id: number }> {
  const log = (input.log ?? rootLogger).child({
    event: "ship.scoped.explain_thread",
    owner: input.owner,
    repo: input.repo,
    pr_number: input.pr_number,
    comment_id: input.comment_id,
  });

  const promptParts = [`File: ${input.thread.path}`, `Lines: ${input.thread.line_range}`];
  if (input.thread.thread_body !== "") {
    promptParts.push(`Reviewer's question:\n${input.thread.thread_body}`);
  }
  promptParts.push(
    `Diff hunk:\n\`\`\`diff\n${input.thread.diff_hunk}\n\`\`\``,
    `Current code:\n\`\`\`\n${input.thread.code_snippet}\n\`\`\``,
  );
  const userPrompt = promptParts.join("\n\n");

  const explanation = await input.callLlm({
    systemPrompt: EXPLAIN_THREAD_SYSTEM_PROMPT,
    userPrompt,
  });

  const reply = await input.octokit.rest.pulls.createReplyForReviewComment({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pr_number,
    comment_id: input.comment_id,
    body: explanation.trim(),
  });

  log.info({ reply_id: reply.data.id }, "ship.scoped.explain_thread posted");
  return { reply_id: reply.data.id };
}
