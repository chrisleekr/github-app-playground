# Contributing

Thank you for contributing to `@chrisleekr-bot`. This guide covers local setup,
the development workflow, and the conventions enforced by the tooling.

---

## Prerequisites

| Tool                          | Version | Purpose                                    |
| ----------------------------- | ------- | ------------------------------------------ |
| [Bun](https://bun.sh)         | ≥ 1.3.8 | Runtime and package manager                |
| [Git](https://git-scm.com)    | any     | Version control                            |
| [Node.js](https://nodejs.org) | ≥ 20    | Required by the Claude Code CLI subprocess |

---

## Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/chrisleekr/github-app-playground.git
cd github-app-playground

# 2. Install dependencies (also installs Husky pre-commit hooks)
bun install

# 3. Copy and fill in the environment file
cp .env.example .env
# Edit .env — see docs/SETUP.md for the full variable reference
```

---

## Development Workflow

### Start the server in watch mode

```bash
bun run dev
```

The server starts on `PORT` (default `3000`) and restarts automatically on file changes.

### Expose the server for webhook delivery (optional)

GitHub must reach your webhook URL over the internet. Use a tunnelling tool during development:

```bash
# ngrok — generates a public HTTPS URL
bun run dev:ngrok   # alias for: ngrok http 3000
```

Paste the generated URL into the GitHub App webhook settings.

---

## Testing

```bash
bun test                  # run all tests once
bun run test:watch        # re-run on file changes
bun run test:coverage     # with coverage report (output in coverage/)
```

Test files live in `test/` and mirror the `src/` directory structure.

---

## Code Quality

Run all checks before opening a pull request:

```bash
bun run typecheck     # TypeScript strict type check (no emit)
bun run lint          # ESLint check
bun run lint:fix      # ESLint auto-fix
bun run format        # Prettier format check
bun run format:fix    # Prettier auto-fix
```

These checks are also enforced by Husky on every commit:

- **pre-commit**: `lint-staged` runs Prettier + ESLint on staged `.ts`/`.js` files and
  Prettier on staged `.json`/`.md`/`.yml` files.
- **commit-msg**: `commitlint` validates the commit message format.

---

## Commit Message Format

Commit messages are validated by
[commitlint](https://commitlint.js.org) using the
[Conventional Commits](https://www.conventionalcommits.org) specification.

### Format

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Allowed types

| Type       | When to use                                           |
| ---------- | ----------------------------------------------------- |
| `feat`     | A new feature                                         |
| `fix`      | A bug fix                                             |
| `docs`     | Documentation changes only                            |
| `style`    | Formatting, whitespace — no logic change              |
| `refactor` | Code change that is neither a fix nor a feature       |
| `test`     | Adding or updating tests                              |
| `chore`    | Build scripts, dependency updates, tooling            |
| `perf`     | Performance improvement                               |
| `build`    | Build system or external dependency changes           |
| `ci`       | CI/CD configuration changes                           |
| `revert`   | Reverts a previous commit                             |
| `localize` | Internationalisation / translation changes            |
| `bump`     | Version bump (typically automated by release tooling) |

### Examples

```bash
feat(mcp): add Slack notification MCP server
fix(checkout): handle empty branch name on issue events
docs: fix Section 7 anchor link in SETUP.md
test(router): add duplicate delivery idempotency test
chore: upgrade @anthropic-ai/claude-agent-sdk to 0.3.0
```

---

## Pull Request Guidelines

- Keep each PR focused on a single concern.
- Fill in the PR template (`.github/PULL_REQUEST_TEMPLATE.md`).
- All checks must pass before requesting review:
  - `bun test` — all tests green
  - `bun run typecheck` — no type errors
  - `bun run lint` — no lint errors
  - `bun run format` — no formatting violations

---

## Project Structure

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full directory layout and
request flow. See [docs/EXTENDING.md](docs/EXTENDING.md) for how to add new webhook
event handlers and MCP servers.
