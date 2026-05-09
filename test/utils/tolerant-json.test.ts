import { describe, expect, it } from "bun:test";

import { escapeRawControlsInJsonStrings, parseTolerantJson } from "../../src/utils/tolerant-json";

describe("escapeRawControlsInJsonStrings", () => {
  it("returns valid JSON unchanged (idempotent)", () => {
    const valid = '{"mode":"answer","reply":"hello\\nworld","n":1}';
    expect(escapeRawControlsInJsonStrings(valid)).toBe(valid);
  });

  it("escapes a literal LF inside a string value", () => {
    const broken = '{"reply":"line1\nline2"}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    expect(repaired).toBe('{"reply":"line1\\nline2"}');
    expect((JSON.parse(repaired) as { reply: string }).reply).toBe("line1\nline2");
  });

  it("escapes literal CR + LF (CRLF) inside a string value", () => {
    const broken = '{"reply":"line1\r\nline2"}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    expect(repaired).toBe('{"reply":"line1\\r\\nline2"}');
  });

  it("escapes a literal TAB inside a string value", () => {
    const broken = '{"reply":"col1\tcol2"}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    expect(repaired).toBe('{"reply":"col1\\tcol2"}');
  });

  it("preserves structural newlines OUTSIDE string values", () => {
    const broken = '{\n  "reply": "x\ny"\n}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    // Outside-string LFs preserved; inside-string LF escaped.
    expect(repaired).toBe('{\n  "reply": "x\\ny"\n}');
    expect((JSON.parse(repaired) as { reply: string }).reply).toBe("x\ny");
  });

  it("handles escaped quotes inside a string without prematurely closing", () => {
    // String contains an escaped quote AND a raw newline after it.
    const broken = '{"reply":"he said \\"hi\\"\nbye"}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    expect(JSON.parse(repaired)).toEqual({ reply: 'he said "hi"\nbye' });
  });

  it("treats a doubled backslash before a quote as a closed string", () => {
    // `"\\"` ends the string (the `\\` is an escaped backslash, then `"` closes).
    // Anything after that quote is OUTSIDE the string and must NOT be escaped.
    const valid = '{"a":"x\\\\","b":"y\nz"}';
    const repaired = escapeRawControlsInJsonStrings(valid);
    // `"a"` value has a literal backslash; `"b"` value's raw LF gets escaped.
    expect(JSON.parse(repaired)).toEqual({ a: "x\\", b: "y\nz" });
  });

  it("escapes other ASCII control bytes (NUL, BEL) as \\uXXXX inside strings", () => {
    const broken = '{"reply":"a\x00b\x07c"}';
    const repaired = escapeRawControlsInJsonStrings(broken);
    expect(repaired).toBe('{"reply":"a\\u0000b\\u0007c"}');
    expect(JSON.parse(repaired)).toEqual({ reply: "a\x00b\x07c" });
  });
});

describe("parseTolerantJson", () => {
  it("parses idiomatic valid JSON via the strict path", () => {
    expect(parseTolerantJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers from raw newlines inside string values", () => {
    const broken = '{"reply":"hello\nworld"}';
    expect(parseTolerantJson(broken)).toEqual({ reply: "hello\nworld" });
  });

  it("recovers from a multi-line markdown reply (real failure shape)", () => {
    const broken =
      '{\n  "mode": "answer",\n  "reply": "_💡 Explanation_\n\n**bold**\n\n1. item"\n}';
    expect(parseTolerantJson(broken)).toEqual({
      mode: "answer",
      reply: "_💡 Explanation_\n\n**bold**\n\n1. item",
    });
  });

  it("throws on genuinely malformed JSON (unbalanced brace)", () => {
    expect(() => parseTolerantJson('{"a":1')).toThrow();
  });

  it("throws on non-JSON garbage", () => {
    expect(() => parseTolerantJson("definitely not json")).toThrow();
  });
});
