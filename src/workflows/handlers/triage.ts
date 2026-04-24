import type { WorkflowHandler } from "../registry";

/**
 * Triage handler (T020). Classifies an issue into a recommended next workflow.
 *
 * MVP implementation: fetches the issue body and applies a simple keyword
 * heuristic. A real LLM-backed classifier (following the adaptor pattern in
 * `src/orchestrator/triage.ts`) lands in a follow-up — the WorkflowRunContext
 * surface and state shape are already correct so the swap is local.
 */
export const handler: WorkflowHandler = async (ctx) => {
  try {
    const { octokit, target } = ctx;

    const { data: issue } = await octokit.rest.issues.get({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.number,
    });

    const body = (issue.body ?? "").toLowerCase();
    const title = issue.title.toLowerCase();
    const haystack = `${title}\n${body}`;

    let verdict: "bug" | "feature" | "question" | "unclear";
    let recommendedNext: "plan" | "clarify";
    let rationale: string;

    if (/\b(bug|error|broken|crash|regression|fails?)\b/.test(haystack)) {
      verdict = "bug";
      recommendedNext = "plan";
      rationale = "mentions bug / error / crash terminology";
    } else if (/\b(feature|add|implement|support)\b/.test(haystack)) {
      verdict = "feature";
      recommendedNext = "plan";
      rationale = "mentions new-feature language";
    } else if (/\b(how|why|what|question)\b/.test(haystack) || haystack.includes("?")) {
      verdict = "question";
      recommendedNext = "clarify";
      rationale = "reads as a question rather than a work item";
    } else {
      verdict = "unclear";
      recommendedNext = "clarify";
      rationale = "no strong signal from heuristic keywords";
    }

    const state = { verdict, recommendedNext, rationale };
    const humanMessage = `triage complete — verdict: **${verdict}** (next: ${recommendedNext}). ${rationale}.`;

    await ctx.setState(state, humanMessage);

    return { status: "succeeded", state, humanMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: `triage failed: ${message}` };
  }
};
