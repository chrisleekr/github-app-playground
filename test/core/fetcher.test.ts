import { describe, expect, it } from "bun:test";

import { filterByTriggerTime } from "../../src/core/fetcher";

const TRIGGER = "2025-06-01T12:00:00Z";

/** Build a comment-shaped object for test clarity */
function item(
  createdAt: string,
  opts?: { updatedAt?: string; lastEditedAt?: string },
): { createdAt: string; updatedAt?: string; lastEditedAt?: string } {
  return {
    createdAt,
    updatedAt: opts?.updatedAt,
    lastEditedAt: opts?.lastEditedAt,
  };
}

describe("filterByTriggerTime", () => {
  describe("createdAt filtering", () => {
    it("keeps items created before the trigger time", () => {
      const items = [item("2025-06-01T11:59:59Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("removes items created exactly at the trigger time", () => {
      const items = [item("2025-06-01T12:00:00Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("removes items created after the trigger time", () => {
      const items = [item("2025-06-01T12:00:01Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });
  });

  describe("lastEditedAt filtering (TOCTOU protection)", () => {
    it("removes items edited at or after trigger, even if created before", () => {
      const items = [item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T12:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("removes items edited after the trigger time", () => {
      const items = [item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T13:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("keeps items edited before trigger time", () => {
      const items = [item("2025-06-01T10:00:00Z", { lastEditedAt: "2025-06-01T11:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("prefers lastEditedAt over updatedAt when both are present", () => {
      // lastEditedAt is before trigger, updatedAt is after — item must be kept.
      const items = [
        item("2025-06-01T10:00:00Z", {
          lastEditedAt: "2025-06-01T11:00:00Z",
          updatedAt: "2025-06-01T13:00:00Z",
        }),
      ];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });
  });

  describe("updatedAt fallback (when lastEditedAt is absent)", () => {
    it("removes items updated at or after trigger when lastEditedAt is absent", () => {
      const items = [item("2025-06-01T11:00:00Z", { updatedAt: "2025-06-01T12:00:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(0);
    });

    it("keeps items with updatedAt before trigger when lastEditedAt is absent", () => {
      const items = [item("2025-06-01T10:00:00Z", { updatedAt: "2025-06-01T11:30:00Z" })];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty input", () => {
      expect(filterByTriggerTime([], TRIGGER)).toHaveLength(0);
    });

    it("handles items with no updatedAt or lastEditedAt (created-only filter)", () => {
      const items = [item("2025-06-01T11:00:00Z")];
      expect(filterByTriggerTime(items, TRIGGER)).toHaveLength(1);
    });

    it("filters multiple items correctly", () => {
      const items = [
        item("2025-06-01T10:00:00Z"), // keep
        item("2025-06-01T12:00:01Z"), // remove — created after
        item("2025-06-01T11:00:00Z", { lastEditedAt: "2025-06-01T12:30:00Z" }), // remove — edited after
        item("2025-06-01T09:00:00Z", { updatedAt: "2025-06-01T11:00:00Z" }), // keep
      ];
      const result = filterByTriggerTime(items, TRIGGER);
      expect(result).toHaveLength(2);
    });
  });
});
