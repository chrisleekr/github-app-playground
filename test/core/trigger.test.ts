import { describe, expect, it } from "bun:test";

import { containsTrigger } from "../../src/core/trigger";

describe("containsTrigger", () => {
  it("detects trigger phrase at start of comment", () => {
    expect(containsTrigger("@chrisleekr-bot review this")).toBe(true);
  });

  it("detects trigger phrase in middle of comment", () => {
    expect(containsTrigger("Hey @chrisleekr-bot please review")).toBe(true);
  });

  it("detects trigger phrase at end of comment", () => {
    expect(containsTrigger("Please help @chrisleekr-bot")).toBe(true);
  });

  it("detects trigger phrase followed by punctuation", () => {
    expect(containsTrigger("@chrisleekr-bot, please review")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot. Done")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot!")).toBe(true);
  });

  it("returns false when trigger phrase is absent", () => {
    expect(containsTrigger("no mention here")).toBe(false);
  });

  it("returns false for partial matches", () => {
    expect(containsTrigger("@chrisleekr-bots not exact")).toBe(false);
  });

  it("handles empty body", () => {
    expect(containsTrigger("")).toBe(false);
  });
});
