import { describe, expect, it } from "bun:test";

import {
  renderProposalComment,
  renderProposalExpired,
  renderProposalNudge,
  renderProposalSupersededByEdit,
} from "../../src/utils/proposal-template";

describe("proposal-template", () => {
  describe("renderProposalComment", () => {
    it("includes the verb and explicit 'react on this comment' wording", () => {
      const body = renderProposalComment({
        verbInPlainEnglish: "open a follow-up issue",
        ttlHours: 24,
        kind: "action:create-issue",
      });
      expect(body).toContain("open a follow-up issue");
      expect(body).toContain("React 👍 **on this comment**");
      expect(body).toContain("24h");
    });

    it("includes a rationale line when provided", () => {
      const body = renderProposalComment({
        verbInPlainEnglish: "run resolve",
        rationale: "CI is red and three threads are unresolved",
        ttlHours: 24,
        kind: "workflow:resolve",
      });
      expect(body).toContain("_Rationale_:");
      expect(body).toContain("CI is red and three threads are unresolved");
    });

    it("uses 'PR/issue' wording for workflow proposals and 'thread' for actions", () => {
      const wf = renderProposalComment({
        verbInPlainEnglish: "do a review",
        ttlHours: 24,
        kind: "workflow:review",
      });
      expect(wf).toContain("PR/issue");

      const action = renderProposalComment({
        verbInPlainEnglish: "resolve this thread",
        ttlHours: 24,
        kind: "action:resolve-thread",
      });
      expect(action).toContain("thread");
    });
  });

  describe("renderProposalSupersededByEdit", () => {
    it("explains that the edit invalidated the prior proposal", () => {
      const body = renderProposalSupersededByEdit();
      expect(body).toContain("edited");
      expect(body).toContain("no longer applies");
    });
  });

  describe("renderProposalExpired", () => {
    it("notes the TTL expiry and prompts a fresh ask", () => {
      const body = renderProposalExpired();
      expect(body).toContain("expired");
      expect(body).toContain("Re-ask");
    });
  });

  describe("renderProposalNudge", () => {
    it("nudges the user about the pending 👍 reaction", () => {
      const body = renderProposalNudge("open a follow-up issue");
      expect(body).toContain("waiting on a 👍");
      expect(body).toContain("open a follow-up issue");
    });
  });
});
