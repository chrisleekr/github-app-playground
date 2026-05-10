/**
 * Meta-issue classifier helper for `bot:open-pr` (FR-035). Single-turn
 * Bedrock call deciding whether an issue is **actionable** (a concrete
 * bug or feature an engineer can implement) versus a meta/tracking/
 * roadmap/discussion/unclear issue that should NOT spawn a draft PR.
 *
 * Returned shape: strict Zod-validated:
 *   { actionable: boolean,
 *     kind: 'bug' | 'feature' | 'tracking' | 'meta' | 'roadmap' | 'discussion' | 'unclear',
 *     reason: string }
 *
 * `actionable: true` is reserved for `kind ∈ {'bug', 'feature'}`. All
 * other kinds resolve to `actionable: false`. The `reason` field MUST
 * be quoted verbatim back to the maintainer in the refusal reply.
 */

import { z } from "zod";

import { parseStructuredResponse, withStructuredRules } from "../../../ai/structured-output";

export const META_ISSUE_VERDICT_SCHEMA = z.object({
  actionable: z.boolean(),
  kind: z.enum(["bug", "feature", "tracking", "meta", "roadmap", "discussion", "unclear"]),
  reason: z.string().min(1),
});

export type MetaIssueVerdict = z.infer<typeof META_ISSUE_VERDICT_SCHEMA>;

export const META_ISSUE_SYSTEM_PROMPT = `You decide whether a GitHub issue is **actionable**,
i.e., a concrete bug or feature an engineer can implement in a single PR.
Return ONLY a single JSON object matching this schema and nothing else:
  { "actionable": boolean,
    "kind": "bug"|"feature"|"tracking"|"meta"|"roadmap"|"discussion"|"unclear",
    "reason": string }
"actionable: true" is reserved for kind in {"bug", "feature"}.
All other kinds resolve to actionable: false.
"reason" is a single-sentence justification quoted verbatim to the maintainer.`;

export interface ClassifyMetaIssueInput {
  readonly title: string;
  readonly body: string;
  readonly callLlm: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

/**
 * Classify the issue. Throws on classifier failure (network /
 * rate-limit / unparseable response) so the caller can surface a
 * maintainer-facing error per FR-017.
 */
export async function classifyMetaIssue(input: ClassifyMetaIssueInput): Promise<MetaIssueVerdict> {
  const userPrompt = [`Title: ${input.title}`, `Body:\n${input.body}`].join("\n\n");
  const raw = await input.callLlm({
    systemPrompt: withStructuredRules(META_ISSUE_SYSTEM_PROMPT),
    userPrompt,
  });
  const result = parseStructuredResponse(raw, META_ISSUE_VERDICT_SCHEMA);
  if (!result.ok) {
    if (result.stage === "parse") {
      throw new Error("meta-issue classifier returned non-JSON output");
    }
    throw new Error(`meta-issue classifier output failed schema validation: ${result.error}`);
  }
  // Enforce the actionable invariant deterministically: the LLM is
  // not trusted to apply this rule consistently.
  const enforced: MetaIssueVerdict = {
    ...result.data,
    actionable:
      result.data.actionable && (result.data.kind === "bug" || result.data.kind === "feature"),
  };
  return enforced;
}
