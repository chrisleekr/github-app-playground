/* eslint-disable no-undef */
/**
 * Semantic Release configuration for dev/pre-releases (feature branches).
 * No changelog commits or git pushes — just version bump and GitHub pre-release.
 * npmPublish disabled since this is a private app.
 *
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: [
    "main",
    {
      name: "feat/*",
      prerelease: `dev-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`,
      channel: "dev",
    },
    {
      name: "fix/*",
      prerelease: `dev-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`,
      channel: "dev",
    },
    {
      name: "refactor/*",
      prerelease: `dev-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`,
      channel: "dev",
    },
    {
      name: "perf/*",
      prerelease: `dev-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`,
      channel: "dev",
    },
    {
      name: "revert/*",
      prerelease: `dev-${process.env.GITHUB_SHA?.slice(0, 7) || "local"}`,
      channel: "dev",
    },
  ],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
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
          { type: "localize", release: "patch" },
        ],
      },
    ],
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/npm",
      {
        pkgRoot: ".",
        npmPublish: false,
      },
    ],
    [
      "@semantic-release/exec",
      {
        successCmd: 'echo "${nextRelease.version}" > RELEASE_VERSION',
      },
    ],
  ],
};
