import type { BotContext } from "../types";

/**
 * StaticClassification — the outcome of the deterministic, free-of-cost
 * classifier. Either resolves to a specific container-target target
 * ("clear") or defers to the next cascade step ("ambiguous"). The classifier
 * deliberately does NOT return the `daemon` or `inline` targets — those are
 * platform-wide dispatch-mode choices, not per-event classifications
 * (FR-004, spec §Terminology).
 */
export type StaticClassification =
  | { outcome: "clear"; mode: "shared-runner" | "isolated-job"; reason: "label" | "keyword" }
  | { outcome: "ambiguous" };

/**
 * Canonical label vocabulary the classifier recognises. These strings are
 * compared case-sensitively against the webhook event's `labels` array —
 * GitHub labels are lowercase by convention but the API preserves exact
 * casing, so we match what maintainers actually apply.
 */
const LABEL_FORCE_ISOLATED_JOB = "bot:job";
const LABEL_FORCE_SHARED_RUNNER = "bot:shared";

/**
 * Keyword rules that imply container-capable execution. Matched case-insensitively
 * against the trigger body as whole-word boundaries so that, say, the substring
 * "dindee" in a random identifier doesn't route to isolated-job. The choice of
 * these specific keywords is from spec Acceptance Scenario 1 + research.md —
 * widen cautiously, since every new keyword is a new silent routing rule.
 */
const ISOLATED_JOB_KEYWORDS: readonly string[] = ["docker", "compose", "dind"];

/**
 * Classify a webhook event using deterministic, cost-free rules. Returns
 * either a clear dispatch target or defers via "ambiguous". Pure function —
 * no I/O, no time-dependence, safe to call from anywhere.
 *
 * Precedence (FR-003 + FR-016):
 *   1. Labels win over everything. `bot:job` → isolated-job, `bot:shared` →
 *      shared-runner. If both labels are present (unusual but legal on
 *      GitHub), `bot:job` takes precedence because container-capable is the
 *      stricter environment — a request asking for BOTH should get the
 *      superset, not the subset.
 *   2. Keyword rules apply only when no label matched.
 *   3. Event type currently contributes no heuristic (research.md R1 left
 *      this open; no concrete rule was adopted). Present as an explicit
 *      fall-through so the rule can be added later without restructuring.
 *   4. Otherwise: ambiguous. Callers decide whether to fall back to the
 *      configured default target or invoke triage (auto mode only).
 */
export function classifyStatic(ctx: BotContext): StaticClassification {
  // Step 1 — label precedence. Labels always win over keywords (FR-016 +
  // spec edge case: "labels always win over keywords"). `bot:job` beats
  // `bot:shared` when both are applied — container-capable is the stricter
  // environment that the user clearly wanted at least part of.
  if (ctx.labels.includes(LABEL_FORCE_ISOLATED_JOB)) {
    return { outcome: "clear", mode: "isolated-job", reason: "label" };
  }
  if (ctx.labels.includes(LABEL_FORCE_SHARED_RUNNER)) {
    return { outcome: "clear", mode: "shared-runner", reason: "label" };
  }

  // Step 2 — keyword rules. Whole-word case-insensitive match against the
  // trigger body. Whole-word boundary prevents accidental matches on
  // identifiers (e.g. "composer", "dindee"). Substring match would be
  // cheaper but routing is a high-stakes decision — correctness > speed.
  const body = ctx.triggerBody.toLowerCase();
  for (const keyword of ISOLATED_JOB_KEYWORDS) {
    // Word-boundary regex built from a literal keyword list; no user input
    // reaches the regex constructor, so no ReDoS surface.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const pattern = new RegExp(`\\b${keyword}\\b`);
    if (pattern.test(body)) {
      return { outcome: "clear", mode: "isolated-job", reason: "keyword" };
    }
  }

  // Step 3 — event-type heuristic hook. Currently no rule; documented as a
  // future-extension point. A reviewer seeing a bare fall-through should
  // understand this is intentional per the spec, not an oversight.
  void ctx.eventName;

  // Step 4 — ambiguous. Router's cascade consults defaultDispatchTarget or
  // the triage LLM as appropriate.
  return { outcome: "ambiguous" };
}
