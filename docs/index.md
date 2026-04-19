---
hide:
  - toc
---

# GitHub App Playground

A GitHub App that responds to `@chrisleekr-bot` mentions on pull requests and issues, powered by the Claude Agent SDK. It routes each incoming webhook through a dispatch cascade (inline, daemon, shared-runner, or isolated Kubernetes Job) so a single deployment can serve both trivial chores and long-running refactors.

<!-- prettier-ignore-start -->
<!-- Material for MkDocs grid-cards require 4-space indentation for card
     body content (heading → `---` separator → description paragraph).
     Do not let prettier collapse the indentation to 2 spaces — that makes
     the body escape the <li> and the cards render empty. -->
<div class="grid cards" markdown>

- :material-cog:{ .lg .middle } **[Setup](SETUP.md)**

  ***

  GitHub App creation, local tunnel, environment variables.

- :material-vector-triangle:{ .lg .middle } **[Architecture](ARCHITECTURE.md)**

  ***

  End-to-end request flow and dispatch cascade, from webhook to tracking comment.

- :material-rocket-launch:{ .lg .middle } **[Deployment](DEPLOYMENT.md)**

  ***

  Docker build, health probes, resource sizing.

- :material-puzzle:{ .lg .middle } **[Extending](EXTENDING.md)**

  ***

  Add new webhook handlers and MCP servers.

</div>
<!-- prettier-ignore-end -->

## Operator guides

- [Configuration](CONFIGURATION.md) — every environment variable the app reads.
- [Observability](OBSERVABILITY.md) — log fields, dispatch reasons, alerts.
- [Triage](TRIAGE.md) — auto-mode classifier behaviour and tuning.
- [Daemon mode](DAEMON.md) — standalone worker process.
- [Kubernetes](KUBERNETES.md) — isolated-job mode with RBAC and deployment skeleton.

This site tracks the `main` branch. See the repository `CHANGELOG.md` for release history.
