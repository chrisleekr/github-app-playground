import { describe, expect, it } from "bun:test";

import { parseLiteralCommand } from "../../../src/workflows/ship/literal-command";

describe("parseLiteralCommand", () => {
  it("parses bare verbs to canonical intents", () => {
    expect(parseLiteralCommand("bot:ship")?.intent).toBe("ship");
    expect(parseLiteralCommand("bot:stop")?.intent).toBe("stop");
    expect(parseLiteralCommand("bot:resume")?.intent).toBe("resume");
    expect(parseLiteralCommand("bot:abort-ship")?.intent).toBe("abort");
  });

  it("parses --deadline with h/m/s units", () => {
    expect(parseLiteralCommand("bot:ship --deadline 2h")?.deadline_ms).toBe(7_200_000);
    expect(parseLiteralCommand("bot:ship --deadline 30m")?.deadline_ms).toBe(1_800_000);
    expect(parseLiteralCommand("bot:ship --deadline 90s")?.deadline_ms).toBe(90_000);
  });

  it("parses fractional durations", () => {
    expect(parseLiteralCommand("bot:ship --deadline 1.5h")?.deadline_ms).toBe(5_400_000);
  });

  it("returns null for malformed --deadline", () => {
    expect(parseLiteralCommand("bot:ship --deadline=invalid")).toBeNull();
    expect(parseLiteralCommand("bot:ship --deadline 2")).toBeNull();
    expect(parseLiteralCommand("bot:ship --deadline -1h")).toBeNull();
  });

  it("returns null for deadlines over the env ceiling", () => {
    expect(parseLiteralCommand("bot:ship --deadline 999h")).toBeNull();
  });

  it("returns null for non-matching content", () => {
    expect(parseLiteralCommand("bot:something-else")).toBeNull();
    expect(parseLiteralCommand("please ship")).toBeNull();
    expect(parseLiteralCommand("")).toBeNull();
  });

  it("scans line-by-line; first match wins", () => {
    const body = "thanks!\nbot:ship\nmore comment text";
    expect(parseLiteralCommand(body)?.intent).toBe("ship");
  });

  it("returns deadline_ms undefined for verb-only commands", () => {
    expect(parseLiteralCommand("bot:ship")?.deadline_ms).toBeUndefined();
  });
});
