# syntax=docker/dockerfile:1
# hadolint global ignore=DL3008

# Multi-stage Dockerfile: Bun (app server) + Node.js (Claude Code CLI)
# Per Bun Docker guide: https://bun.sh/guides/ecosystem/docker
# Per Claude Agent SDK hosting guide: https://platform.claude.com/docs/en/agent-sdk/hosting
# Pattern adapted from mcp-server-playground

FROM oven/bun:1.3.12 AS base
WORKDIR /app

# Node.js required by Claude Code CLI; git required for repo checkout
# Uses GPG-based NodeSource installation (avoids curl-pipe-bash pattern).
# ca-certificates and gnupg are required for GPG key verification.
# curl is REQUIRED by the production HEALTHCHECK (see end of Dockerfile) — do not remove.
# See: https://github.com/nodesource/distributions#installation-instructions-deb
RUN apt-get update && apt-get install -y --no-install-recommends \
  curl git ca-certificates gnupg && \
  mkdir -p /etc/apt/keyrings && \
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list && \
  apt-get update && \
  apt-get install -y --no-install-recommends nodejs && \
  rm -rf /var/lib/apt/lists/*

# Base-image CVE patches: oven/bun:1.3.12 bakes in openssl 3.5.4-1~deb13u2
# (Trivy flags CVE-2026-28390 HIGH, fix in 3.5.5). The apt-get install
# above only touches *requested* packages — it does not upgrade libs
# already baked into the base layer — so we force a targeted upgrade here.
# Targeted rather than dist-upgrade keeps rebuilds reproducible; the CI
# Trivy gate catches any new flagged package once the vuln DB updates.
RUN apt-get update && \
  apt-get upgrade -y --no-install-recommends \
    openssl libssl3t64 openssl-provider-legacy && \
  rm -rf /var/lib/apt/lists/*

# NodeSource node_20.x bundles npm 10.x, whose vendored tar/minimatch/
# glob/cross-spawn/brace-expansion have HIGH CVEs that Trivy blocks on.
# npm 11.x ships patched vendored deps and replaces them in
# /usr/lib/node_modules/npm/ in place. Tracks the 11.x major (unlike the
# exact pins elsewhere in this file) so future vendored-dep patches land
# automatically; the CI Trivy gate catches any regression.
RUN npm install -g npm@11

# Claude Code CLI required by @anthropic-ai/claude-agent-sdk
# Pinned to a specific version for reproducible builds.
# See: https://www.npmjs.com/package/@anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-code@2.1.101

# Stage 1: Build — install all deps and bundle the main app
FROM base AS development
ENV HUSKY=0
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Stage 2: Production deps only
FROM base AS deps
COPY package.json bun.lock ./
# --ignore-scripts: Skip lifecycle scripts (prepare/postinstall) because husky
# is a devDependency not installed with --production, causing "husky: not found"
RUN bun install --frozen-lockfile --production --ignore-scripts

# Stage 3: Production
FROM base AS production

ARG PACKAGE_VERSION=untagged
ARG GIT_HASH=unspecified

# claude-code is installed globally by npm (see base stage above).
# The Agent SDK defaults to {cwd}/dist/cli.js which does not exist in this image.
# Setting ENV here bakes the correct path in; it can still be overridden at runtime.
ENV CLAUDE_CODE_PATH=/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js

LABEL maintainer="Chris Lee"
LABEL com.chrisleekr.bot.package-version=${PACKAGE_VERSION}
LABEL com.chrisleekr.bot.git-hash=${GIT_HASH}

# Bundled app and MCP stdio servers (dist/app.js, dist/mcp/servers/*.js)
# MCP servers are bundled by scripts/build.ts alongside the main app — no TS source in production
COPY --from=development --chown=bun:bun /app/dist ./dist
COPY --from=development --chown=bun:bun /app/package.json ./

# SQL migration files — not bundled by Bun.build, copied as-is.
# migrate.ts resolves these via process.cwd() + "src/db/migrations".
COPY --from=development --chown=bun:bun /app/src/db/migrations ./src/db/migrations

# Production node_modules (runtime dependencies only)
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules

# Docker CLI — required when the image runs as an isolated-job pod (the
# Claude agent shells `docker build` / `docker compose` against the dind
# sidecar at DOCKER_HOST=tcp://localhost:2375). Copy the static client binary
# from the official `docker:27-cli` image to avoid pulling the full dind
# runtime into the server image. Pinned to the same major as the sidecar in
# src/k8s/job-spawner.ts to keep client/daemon compatibility guaranteed.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

USER bun
EXPOSE 3000/tcp
EXPOSE 3002/tcp
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/healthz || exit 1
# Default: webhook server + orchestrator. For daemon mode, override:
#   docker run ... chrisleekr/github-app-playground bun run dist/daemon/main.js
CMD ["bun", "run", "dist/app.js"]
