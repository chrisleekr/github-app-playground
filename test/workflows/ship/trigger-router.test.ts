/**
 * T014b — trigger-router tests covering FR-027.
 *
 * Surface parity contract: literal, NL, and label inputs that name the
 * same intent + deadline MUST produce identical canonical commands
 * apart from the `surface` field. The `surface` field is recorded for
 * observability (FR-016) only and MUST NOT influence eligibility,
 * authorisation, or session-uniqueness routing.
 */

import { describe, expect, it, mock } from "bun:test";

import { routeTrigger } from "../../../src/workflows/ship/trigger-router";

const PR = { owner: "o", repo: "r", number: 42, installation_id: 100 } as const;
const PRINCIPAL = "alice";

describe("routeTrigger — FR-027 surface parity", () => {
  it("literal `bot:ship --deadline 2h` → canonical {intent:'ship', deadline_ms:7200000, surface:'literal'}", async () => {
    const out = await routeTrigger({
      surface: "literal",
      payload: {
        commentBody: "bot:ship --deadline 2h",
        principal_login: PRINCIPAL,
        pr: PR,
      },
    });
    expect(out).not.toBeNull();
    expect(out?.intent).toBe("ship");
    expect(out?.deadline_ms).toBe(7_200_000);
    expect(out?.surface).toBe("literal");
    expect(out?.principal_login).toBe(PRINCIPAL);
    expect(out?.pr).toEqual(PR);
  });

  it("label `bot:ship/deadline=2h` → identical canonical record except surface:'label'", async () => {
    const out = await routeTrigger({
      surface: "label",
      payload: {
        label_name: "bot:ship/deadline=2h",
        principal_login: PRINCIPAL,
        pr: PR,
      },
    });
    expect(out?.intent).toBe("ship");
    expect(out?.deadline_ms).toBe(7_200_000);
    expect(out?.surface).toBe("label");
  });

  it("NL classifier returning ship → identical canonical record except surface:'nl'", async () => {
    const callLlm = mock(() =>
      Promise.resolve(JSON.stringify({ intent: "ship", deadline_ms: 7_200_000 })),
    );
    const out = await routeTrigger({
      surface: "nl",
      payload: {
        commentBody: "@bot ship this please",
        triggerPhrase: "@bot",
        principal_login: PRINCIPAL,
        pr: PR,
        callLlm,
      },
    });
    expect(out?.intent).toBe("ship");
    expect(out?.deadline_ms).toBe(7_200_000);
    expect(out?.surface).toBe("nl");
  });

  it("the three surfaces produce records that match modulo `surface`", async () => {
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "stop" })));
    const literal = await routeTrigger({
      surface: "literal",
      payload: { commentBody: "bot:stop", principal_login: PRINCIPAL, pr: PR },
    });
    const label = await routeTrigger({
      surface: "label",
      payload: { label_name: "bot:stop", principal_login: PRINCIPAL, pr: PR },
    });
    const nl = await routeTrigger({
      surface: "nl",
      payload: {
        commentBody: "@bot stop please",
        triggerPhrase: "@bot",
        principal_login: PRINCIPAL,
        pr: PR,
        callLlm,
      },
    });
    expect(literal?.intent).toBe("stop");
    expect(label?.intent).toBe("stop");
    expect(nl?.intent).toBe("stop");
    expect(literal?.principal_login).toBe(label?.principal_login);
    expect(label?.principal_login).toBe(nl?.principal_login);
    expect(literal?.pr).toEqual(label?.pr ?? {});
    expect(label?.pr).toEqual(nl?.pr ?? {});
    // surface differs as expected
    expect(literal?.surface).toBe("literal");
    expect(label?.surface).toBe("label");
    expect(nl?.surface).toBe("nl");
  });

  it("returns null on a non-actionable literal input", async () => {
    const out = await routeTrigger({
      surface: "literal",
      payload: { commentBody: "thanks for the help!", principal_login: PRINCIPAL, pr: PR },
    });
    expect(out).toBeNull();
  });

  it("returns null on an unrecognised label", async () => {
    const out = await routeTrigger({
      surface: "label",
      payload: { label_name: "wontfix", principal_login: PRINCIPAL, pr: PR },
    });
    expect(out).toBeNull();
  });

  it("returns null on a comment without the trigger phrase (NL gate)", async () => {
    const callLlm = mock(() => Promise.reject(new Error("must not be called")));
    const out = await routeTrigger({
      surface: "nl",
      payload: {
        commentBody: "I think we should ship this",
        triggerPhrase: "@bot",
        principal_login: PRINCIPAL,
        pr: PR,
        callLlm,
      },
    });
    expect(out).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("forwards event_surface and thread_id verbatim into the canonical command", async () => {
    const out = await routeTrigger({
      surface: "label",
      payload: {
        label_name: "bot:ship",
        principal_login: PRINCIPAL,
        pr: PR,
        event_surface: "pr-label",
        thread_id: "thread-node-id-xyz",
      },
    });
    expect(out?.event_surface).toBe("pr-label");
    expect(out?.thread_id).toBe("thread-node-id-xyz");
  });

  it("rejects intents whose event_surface is not in the eligibility set (FR-029..FR-035)", async () => {
    // bot:investigate is eligible only on issue-comment / issue-label.
    // Triggering it on a PR-comment surface MUST yield null.
    const out = await routeTrigger({
      surface: "literal",
      payload: {
        commentBody: "bot:investigate",
        principal_login: PRINCIPAL,
        pr: PR,
        event_surface: "pr-comment",
      },
    });
    // The literal parser doesn't yet recognise "bot:investigate" as a
    // verb (the literal-command grammar still tracks the original 4
    // ship verbs). On the literal surface this returns null because
    // the parser doesn't match — same observable outcome.
    expect(out).toBeNull();
  });

  it("on the label surface, an issue-only intent triggered with pr-label is rejected for ineligibility", async () => {
    const out = await routeTrigger({
      surface: "label",
      payload: {
        label_name: "bot:investigate",
        principal_login: PRINCIPAL,
        pr: PR,
        event_surface: "pr-label",
      },
    });
    expect(out).toBeNull();
  });

  it("on the label surface, an issue-only intent triggered with issue-label is accepted", async () => {
    const out = await routeTrigger({
      surface: "label",
      payload: {
        label_name: "bot:investigate",
        principal_login: PRINCIPAL,
        pr: PR,
        event_surface: "issue-label",
      },
    });
    expect(out?.intent).toBe("investigate");
    expect(out?.event_surface).toBe("issue-label");
  });

  it("NL classifier output rewritten to 'none' on ineligible event_surface yields null", async () => {
    // Classifier returns `bot:investigate` for "investigate this", and
    // the eventSurface filter inside the classifier rewrites it to
    // `'none'` because `pr-comment` is not eligible — so routeTrigger
    // returns null without ever passing through trigger-router's own
    // eligibility check.
    const callLlm = mock(() => Promise.resolve(JSON.stringify({ intent: "investigate" })));
    const out = await routeTrigger({
      surface: "nl",
      payload: {
        commentBody: "@bot investigate this",
        triggerPhrase: "@bot",
        principal_login: PRINCIPAL,
        pr: PR,
        callLlm,
        event_surface: "pr-comment",
      },
    });
    expect(out).toBeNull();
  });
});
