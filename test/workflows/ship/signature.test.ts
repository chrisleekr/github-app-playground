/**
 * Tests for `src/workflows/ship/signature.ts` (T032).
 * Pure function: no DB, no network.
 */

import { describe, expect, it } from "bun:test";

import { deriveSignature } from "../../../src/workflows/ship/signature";

describe("deriveSignature", () => {
  it("(a) Tier 1 determinism: identical inputs → identical signature", () => {
    const sig1 = deriveSignature({
      checkName: "lint",
      conclusion: "FAILURE",
      logs: "  10:5  error  Unexpected console statement  no-console",
    });
    const sig2 = deriveSignature({
      checkName: "lint",
      conclusion: "FAILURE",
      logs: "  10:5  error  Unexpected console statement  no-console",
    });
    expect(sig1.signature).toBe(sig2.signature);
    expect(sig1.tier).toBe(1);
  });

  it("(b) Tier 1 normalisation: same rule on different lines/files → same signature", () => {
    const a = deriveSignature({
      checkName: "lint",
      conclusion: "FAILURE",
      logs: "  10:5  error  Unexpected console statement  no-console",
    });
    const b = deriveSignature({
      checkName: "lint",
      conclusion: "FAILURE",
      logs: "  42:9  error  Unexpected console statement  no-console",
    });
    expect(a.signature).toBe(b.signature);
  });

  it("(c) Tier 2 fallback when Tier 1 yields nothing extractable", () => {
    const sig = deriveSignature({
      checkName: "docker-build",
      conclusion: "FAILURE",
      logs: "Killed (OOM)\nbuild step exited with code 137",
    });
    expect(sig.tier).toBe(2);
    expect(sig.signature.startsWith("t2:docker-build:FAILURE:")).toBe(true);
  });

  it("(d) TypeScript fixture: extracts TS error code", () => {
    const a = deriveSignature({
      checkName: "typecheck",
      conclusion: "FAILURE",
      logs: "src/x.ts(10,5): error TS2304: Cannot find name 'foo'.",
    });
    const b = deriveSignature({
      checkName: "typecheck",
      conclusion: "FAILURE",
      logs: "src/y.ts(99,1): error TS2304: Cannot find name 'foo'.",
    });
    expect(a.tier).toBe(1);
    expect(a.signature).toBe(b.signature);
  });

  it("Tier 2 distinguishes different conclusions", () => {
    const a = deriveSignature({
      checkName: "build",
      conclusion: "FAILURE",
      logs: "exit 1",
    });
    const b = deriveSignature({
      checkName: "build",
      conclusion: "TIMED_OUT",
      logs: "exit 1",
    });
    expect(a.signature).not.toBe(b.signature);
  });
});
