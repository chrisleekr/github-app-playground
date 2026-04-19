---
hide:
  - toc
---

# GitHub App Playground

A GitHub App that responds to `@chrisleekr-bot` mentions on pull requests and issues, powered by the Claude Agent SDK. It routes each incoming webhook through a dispatch cascade (inline, daemon, shared-runner, or isolated Kubernetes Job) so a single deployment can serve both trivial chores and long-running refactors.

<div class="grid cards" markdown>

- :material-cog: **[Setup](SETUP.md)**

  GitHub App creation, local tunnel, environment variables.

- :material-vector-triangle: **[Architecture](ARCHITECTURE.md)**

  End-to-end request flow and dispatch cascade, from webhook to tracking comment.

- :material-rocket-launch: **[Deployment](DEPLOYMENT.md)**

  Docker build, health probes, resource sizing.

- :material-puzzle: **[Extending](EXTENDING.md)**

  Add new webhook handlers and MCP servers.

</div>

## Status

This site tracks the `main` branch and reflects the current documentation set, including both setup and operator-facing guides (configuration, observability, triage, daemon, Kubernetes). See the repository `CHANGELOG.md` for release history.
