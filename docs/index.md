---
hide:
  - toc
---

# GitHub App Playground

A GitHub App that responds to `@chrisleekr-bot` mentions on pull requests and issues, powered by the Claude Agent SDK. Every request is handed off to the daemon fleet over WebSocket; when triage flags the job as heavy or the queue backs up, the orchestrator spawns an ephemeral daemon Pod on Kubernetes so the same image scales on demand.

## Start here

- **[Setup](SETUP.md)** — GitHub App creation, local tunnel, environment variables.
- **[Architecture](ARCHITECTURE.md)** — end-to-end request flow, from webhook through the daemon fleet to the tracking comment.
- **[Deployment](DEPLOYMENT.md)** — Docker build, health probes, resource sizing.
- **[Extending](EXTENDING.md)** — add new webhook handlers and MCP servers.

## Operator guides

- [Configuration](CONFIGURATION.md) — every environment variable the app reads.
- [Observability](OBSERVABILITY.md) — log fields, dispatch reasons, alerts.
- [Triage](TRIAGE.md) — binary heavy-job classifier behaviour and tuning.
- [Daemon mode](DAEMON.md) — persistent vs ephemeral daemons and the WebSocket protocol.

This site tracks the `main` branch. See the repository `CHANGELOG.md` for release history.
