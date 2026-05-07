/**
 * Unit tests for the RESOLVE.md `## Outstanding` section parser (issue #93).
 *
 * The parser is the second of two signals the resolve handler's post-pipeline
 * gate consults: a non-null return means the agent flagged unresolved work
 * even if CI happens to be green at the moment, and the run must finalize as
 * `incomplete` rather than `succeeded`.
 */

import { describe, expect, it } from "bun:test";

import { parseOutstandingSection } from "../../../src/workflows/handlers/resolve-report";

describe("parseOutstandingSection", () => {
  it("returns null for empty / undefined / null input", () => {
    expect(parseOutstandingSection("")).toBeNull();
    expect(parseOutstandingSection(undefined)).toBeNull();
    expect(parseOutstandingSection(null)).toBeNull();
  });

  it("returns null when the section is absent", () => {
    const report = `## Summary\n\nResolve done.\n\n## Commits pushed\n\n- abc123 · fix lint`;
    expect(parseOutstandingSection(report)).toBeNull();
  });

  it("returns null when the section body is whitespace-only", () => {
    const report = `## Summary\n\nDone.\n\n## Outstanding\n\n   \n\t\n\n## Commits pushed\n\n- abc`;
    expect(parseOutstandingSection(report)).toBeNull();
  });

  it("extracts the body up to the next ## heading", () => {
    const report = `## Summary

All good.

## Outstanding

- CI lint check still red
- Need maintainer review of file X

## Commits pushed

- abc123 · fix tests`;
    const body = parseOutstandingSection(report);
    expect(body).not.toBeNull();
    expect(body).toContain("CI lint check still red");
    expect(body).toContain("Need maintainer review of file X");
    expect(body).not.toContain("Commits pushed");
  });

  it("handles a section that runs to the end of the report", () => {
    const report = `## Summary\n\nDone.\n\n## Outstanding\n\nCI failure: typecheck`;
    expect(parseOutstandingSection(report)).toBe("CI failure: typecheck");
  });

  it("matches case-insensitively on the heading text", () => {
    const report = `## OUTSTANDING\n\nstill red`;
    expect(parseOutstandingSection(report)).toBe("still red");
  });

  it("returns null for a report with no headings at all", () => {
    expect(parseOutstandingSection("just some prose without headings")).toBeNull();
  });

  it("is unaffected by an unrelated section that mentions 'outstanding'", () => {
    const report = `## Summary\n\nNothing outstanding remains.\n\n## Commits pushed\n\n- a`;
    expect(parseOutstandingSection(report)).toBeNull();
  });
});
