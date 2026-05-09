/**
 * Tolerant JSON parsing for LLM outputs.
 *
 * The most common failure mode of LLMs emitting JSON is leaking literal
 * control bytes (LF, CR, TAB) inside string values rather than escaping
 * them as `\n` / `\r` / `\t`. JSON.parse rejects those bytes per RFC 8259
 * §7. This module repairs that specific class of malformation without
 * altering structure or content semantics.
 *
 * Pure module — no I/O, no dependencies. Reusable outside the LLM path.
 */

/**
 * Walks the input tracking JSON string-state with proper backslash-escape
 * handling, and replaces raw LF/CR/TAB bytes inside string values with
 * their JSON-escape sequences. Other ASCII control bytes (U+0000..U+001F)
 * inside strings are escaped as `\uXXXX`. Bytes outside string values are
 * preserved verbatim, so structural whitespace (newlines between keys)
 * stays valid.
 *
 * Idempotent on already-valid JSON.
 */
export function escapeRawControlsInJsonStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Parse a JSON string, tolerating raw control bytes inside string values.
 *
 * Strategy:
 *   1. Try strict `JSON.parse` first (fast path; idiomatic JSON unchanged).
 *   2. On failure, repair raw control bytes inside string values and retry.
 *   3. If still unparseable, throws the second-attempt error.
 *
 * Does NOT strip markdown code fences — that's a separate concern handled
 * by the caller (e.g., `parseStructuredResponse`).
 */
export function parseTolerantJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return JSON.parse(escapeRawControlsInJsonStrings(input));
  }
}
