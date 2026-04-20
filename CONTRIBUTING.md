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
bun test                  # run all tests once (with coverage by default via bunfig.toml)
bun run test:watch        # re-run on file changes
bun run test:coverage     # explicit coverage report (output in coverage/)
```

Test files live in `test/` and mirror the `src/` directory structure.

**Coverage threshold**: `bunfig.toml` enforces a per-file minimum of **90%
lines and 90% functions** via Bun's native `coverageThreshold`. Any PR that
drops a file below either threshold will fail `bun test` locally and in CI.

**Mocking**: External dependencies (GitHub API, Claude Agent SDK, git CLI)
MUST be mocked in tests — no real API calls in the test suite. See the
existing `test/webhook/router.test.ts` for the project's mocking patterns
using Bun's `mock.module()`.

---

## Code Quality

Before opening a pull request, run the unified quality gate — it runs
typecheck, lint, format check, and tests sequentially:

```bash
bun run check
```

Equivalent to running these four commands in order:

```bash
bun run typecheck     # TypeScript strict type check (no emit)
bun run lint          # ESLint check
bun run format        # Prettier format check
bun test              # Tests with coverage threshold enforcement
```

Auto-fix helpers (run individually as needed):

```bash
bun run lint:fix      # ESLint auto-fix
bun run format:fix    # Prettier auto-fix
```

### Pre-commit hooks

These checks are enforced by Husky on every commit:

- **pre-commit** runs, in order:
  1. `gitleaks protect --verbose --staged --config .gitleaks.toml` scans
     staged files for secrets (API keys, tokens, private keys). The
     `gitleaks` binary is **required** — install via `brew install gitleaks`
     on macOS, `sudo apt install gitleaks` on Debian/Ubuntu, or
     `go install github.com/gitleaks/gitleaks/v8@latest`. The hook fails
     closed: if the binary is missing, the commit is blocked with install
     guidance.
  2. `lint-staged` runs Prettier + ESLint on staged `.ts`/`.js` files and
     Prettier on staged `.json`/`.md`/`.yml` files.
- **commit-msg**: `commitlint` validates the commit message format.

Allowlist false positives in `.gitleaks.toml` rather than bypassing the hook
with `--no-verify`. CI also runs gitleaks on every push to branches except
`gh-pages` via `.github/workflows/secrets-scan.yml`, independently of the
main CI pipeline, so a bypassed local hook still fails the build.

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
