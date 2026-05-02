/**
 * Bot reply formatter — emits the CodeRabbit-style 3-block layout
 * shared by every bot reply surface (resolve, review, fix-thread,
 * explain-thread). Format: `<status>[meta]` line, blank, bold title,
 * blank, prose reasoning.
 *
 * NOTE: the LLM agent prompts in `buildResolvePrompt` /
 * `buildReviewPrompt` and `EXPLAIN_THREAD_SYSTEM_PROMPT` describe this
 * same shape inline — agents don't run TypeScript, so the format
 * description has to live verbatim in the prompt strings. Keep the
 * agent-facing examples in those prompts in sync with the output of
 * this helper.
 */
export function formatReply(opts: {
  readonly status: string;
  readonly meta?: string;
  readonly title: string;
  readonly reasoning: string;
}): string {
  const header = opts.meta !== undefined ? `${opts.status}${opts.meta}` : opts.status;
  const titleLine = `**${opts.title}**`;
  return [header, "", titleLine, "", opts.reasoning.trim()].join("\n");
}
