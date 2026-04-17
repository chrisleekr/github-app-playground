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
const sha7 = process.env.GITHUB_SHA?.slice(0, 7) || "local";

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
      { name: "feat/*", prerelease: `dev-${sha7}`, channel: "dev" },
      { name: "fix/*", prerelease: `dev-${sha7}`, channel: "dev" },
      { name: "refactor/*", prerelease: `dev-${sha7}`, channel: "dev" },
      { name: "perf/*", prerelease: `dev-${sha7}`, channel: "dev" },
      { name: "revert/*", prerelease: `dev-${sha7}`, channel: "dev" },
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
