import { describe, expect, it } from "bun:test";

import { parseLabelTrigger } from "../../../src/workflows/ship/label-trigger";

describe("parseLabelTrigger", () => {
  it("parses each recognised stem to the canonical intent", () => {
    expect(parseLabelTrigger("bot:ship")?.intent).toBe("ship");
    expect(parseLabelTrigger("bot:stop")?.intent).toBe("stop");
    expect(parseLabelTrigger("bot:resume")?.intent).toBe("resume");
    expect(parseLabelTrigger("bot:abort-ship")?.intent).toBe("abort");
  });

  it("parses /deadline= override on bot:ship", () => {
    expect(parseLabelTrigger("bot:ship/deadline=2h")?.deadline_ms).toBe(7_200_000);
    expect(parseLabelTrigger("bot:ship/deadline=30m")?.deadline_ms).toBe(1_800_000);
  });

  it("returns null for unrecognised labels", () => {
    expect(parseLabelTrigger("wontfix")).toBeNull();
    expect(parseLabelTrigger("bot:something")).toBeNull();
    expect(parseLabelTrigger("")).toBeNull();
  });

  it("returns null for malformed deadline values", () => {
    expect(parseLabelTrigger("bot:ship/deadline=invalid")).toBeNull();
    expect(parseLabelTrigger("bot:ship/deadline=-1h")).toBeNull();
    expect(parseLabelTrigger("bot:ship/deadline=999h")).toBeNull();
  });
});
