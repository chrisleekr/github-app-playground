// Spawned as a child process by test/utils/fatal-handlers.test.ts to exercise
// the real process-level crash handlers installed by installFatalHandlers.
// Run it in isolation (not via the test runner) so the uncaughtException /
// unhandledRejection -> process.exit(1) path does not tear down bun:test.
//
// argv[2]: "uncaught" -> throw asynchronously; "unhandled" -> reject with an
// Error; "unhandled-string" -> reject with a bare string (the non-Error path
// that must still be redacted).
import { installFatalHandlers } from "../../src/logger";

installFatalHandlers("daemon");

// Correctly-formatted GitHub installation token (ghs_ + 36 chars) so the
// errSerializer redaction regex matches; a wrong length would not be scrubbed.
const token = `ghs_${"A".repeat(36)}`;

if (process.argv[2] === "unhandled") {
  void Promise.reject(new Error(`rejected with ${token}`));
} else if (process.argv[2] === "unhandled-string") {
  // Non-Error rejection reason: errSerializer scrubs it only after coercion.
  // Rejecting with a non-Error is the exact case under test, so the lint rule
  // guarding against it is disabled here intentionally.
  // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors
  void Promise.reject(`rejected with string ${token}`);
} else if (process.argv[2] === "unhandled-object") {
  // Bare object with an opaque (non-ghs) secret under a sensitive key name:
  // only scrubStructured (by field name) censors it, since the message regex
  // does not match a non-pattern secret.
  // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors
  void Promise.reject({ headers: { authorization: "Bearer opaque-non-ghs-secret-XYZ" } });
} else {
  setImmediate(() => {
    throw new Error(`boom with ${token}`);
  });
}
