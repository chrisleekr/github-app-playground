# syntax=docker/dockerfile:1
# hadolint global ignore=DL3008

# Multi-stage Dockerfile: Bun (app server) + Node.js (Claude Code CLI)
# Per Bun Docker guide: https://bun.sh/guides/ecosystem/docker
# Per Claude Agent SDK hosting guide: https://platform.claude.com/docs/en/agent-sdk/hosting
# Pattern adapted from mcp-server-playground

FROM oven/bun:1.3.8 AS base
WORKDIR /app

# Node.js required by Claude Code CLI; git required for repo checkout
# Uses GPG-based NodeSource installation (avoids curl-pipe-bash pattern).
# ca-certificates and gnupg are required for GPG key verification.
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

# Claude Code CLI required by @anthropic-ai/claude-agent-sdk
# Pinned to a specific version for reproducible builds.
# See: https://www.npmjs.com/package/@anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-code@2.1.45

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

# Production node_modules (runtime dependencies only)
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules

USER bun
EXPOSE 3000/tcp
ENTRYPOINT ["bun", "run", "dist/app.js"]
