/* eslint-disable no-undef */
/**
 * Semantic Release configuration — single file for both dev and prod.
 *
 * Mode is selected by SEMREL_CHANNEL env var (set by the caller workflow):
 *   - SEMREL_CHANNEL=dev  → pre-release tags on feat/fix/refactor/perf/revert
 *                          branches (no changelog, no release commit, no GitHub
 *                          release entry — pre-release only via tag).
 *   - SEMREL_CHANNEL=prod → release on main (changelog, release commit,
 *                          GitHub release entry).
 *
 * Reason for env-switch instead of a second config file:
 *   semantic-release has no CLI/env config-path flag (verified against
 *   https://semantic-release.gitbook.io/semantic-release/usage/configuration)
 *   so the previous setup file-swapped release.config.dev.mjs into place.
 *   That swap was fragile (no failure trap). Single config + env switch is
 *   the supported workaround.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
const channel = process.env.SEMREL_CHANNEL || "prod";
const isDev = channel === "dev";

// Lodash template evaluated per-branch by semantic-release. `name` is the
// matched branch name (e.g. "fix/test-run-bugs"); we strip non-semver chars
// so the resulting prerelease identifier is valid SemVer-9.
//
// Why not `dev-${GITHUB_SHA}` (the prior scheme): that string is JS-evaluated
// once at config load, so every glob entry below ends up with the *same*
// prerelease value. semantic-release then expands the globs against all
// remote branches and rejects the config with EPRERELEASEBRANCHES because
// "Each pre-release branch ... must have a unique prerelease property".
// Per-commit uniqueness is still handled by semantic-release's prerelease
// counter (e.g. 0.4.0-fix-test-run-bugs.1 → .2 → .3).
const PRERELEASE_TEMPLATE = "${name.replace(/[^a-zA-Z0-9-]/g, '-')}";

const releaseRules = [
  { type: "feat", release: "minor" },
  { type: "fix", release: "patch" },
  { type: "refactor", release: "patch" },
  { type: "perf", release: "patch" },
  { type: "revert", release: "patch" },
  { type: "docs", release: false },
  { type: "style", release: false },
  { type: "chore", release: false },
  { type: "test", release: false },
  { type: "build", release: false },
  { type: "ci", release: false },
  { type: "bump", release: "patch" },
  ...(isDev ? [{ type: "localize", release: "patch" }] : []),
];

const branches = isDev
  ? [
      "main",
      { name: "feat/*", prerelease: PRERELEASE_TEMPLATE, channel: "dev" },
      { name: "fix/*", prerelease: PRERELEASE_TEMPLATE, channel: "dev" },
      { name: "refactor/*", prerelease: PRERELEASE_TEMPLATE, channel: "dev" },
      { name: "perf/*", prerelease: PRERELEASE_TEMPLATE, channel: "dev" },
      { name: "revert/*", prerelease: PRERELEASE_TEMPLATE, channel: "dev" },
    ]
  : ["main"];

const plugins = [
  ["@semantic-release/commit-analyzer", { releaseRules }],
  "@semantic-release/release-notes-generator",
  ...(isDev ? [] : [["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }]]),
  ["@semantic-release/npm", { pkgRoot: ".", npmPublish: false }],
  ...(isDev
    ? []
    : [
        [
          "@semantic-release/git",
          {
            assets: ["package.json", "CHANGELOG.md"],
            message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
          },
        ],
        "@semantic-release/github",
      ]),
  ["@semantic-release/exec", { successCmd: 'echo "${nextRelease.version}" > RELEASE_VERSION' }],
];

export default { branches, plugins };
