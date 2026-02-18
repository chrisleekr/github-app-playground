# GitHub App Setup Guide

Step-by-step guide for registering, configuring, and deploying the `@chrisleekr-bot` GitHub App.

## Prerequisites

### Required for all environments

| Tool                                               | Version | Purpose                                                                |
| -------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| [Bun](https://bun.sh)                              | ≥ 1.3.8 | Runtime and package manager (`engines.bun` in `package.json`)          |
| [Git](https://git-scm.com)                         | any     | Repository checkout during agent execution                             |
| GitHub account                                     | —       | Admin access to the target org or personal account                     |
| Publicly reachable HTTPS URL                       | —       | Webhook endpoint (`https://github.chrislee.local/api/github/webhooks`) |
| [Anthropic API key](https://console.anthropic.com) | —       | Required when `CLAUDE_PROVIDER=anthropic` (default)                    |

### Required for Amazon Bedrock only

| Tool / Permission                                             | Purpose                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| AWS account with Bedrock access                               | Hosting Claude via AWS                                            |
| `AWS_REGION` set to a region with Bedrock enabled             | e.g. `us-east-1`                                                  |
| One of: AWS SSO profile, IAM access keys, OIDC token, or IRSA | Authentication (see [Section 7](#7-amazon-bedrock-configuration)) |

---

## 1. Create the GitHub App

This section walks through every field in the GitHub App registration form in the exact order it appears in the GitHub UI. Complete all steps before clicking **Create GitHub App** at the end.

### 1.1 Navigate to the registration form

**For a personal account:**

1. Click your **profile picture** in the top-right corner of any GitHub page
2. Click **Settings**
3. In the left sidebar, scroll to the bottom and click **Developer settings**
4. In the left sidebar, click **GitHub Apps**
5. Click **New GitHub App**

**For an organization:**

1. Click your **profile picture** → **Your organizations**
2. Click **Settings** to the right of the target organization
3. In the left sidebar, click **Developer settings**
4. In the left sidebar, click **GitHub Apps**
5. Click **New GitHub App**

Direct link: [https://github.com/settings/apps/new](https://github.com/settings/apps/new)

> A user or organization can register up to 100 GitHub Apps. There is no limit to how many apps can be installed on an account.
> Source: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

---

### 1.2 Basic Information

Fill in the first three fields at the top of the form:

#### GitHub App name

```
chrisleekr-bot
```

- Must be **globally unique** across all of GitHub — no two apps can share a name regardless of owner.
- Maximum 34 characters.
- The name is converted to lowercase with spaces replaced by `-` and special characters removed before it is displayed in the GitHub UI (e.g. `My App` → `my-app`). This slugified form is what users will see when the bot takes an action.
- You **cannot** use the same name as an existing GitHub account unless it is your own user or organization name.

> If the name is already taken, GitHub will show a validation error when you try to submit the form. Add a suffix (e.g. `-bot`, `-dev`) to make it unique.

#### Homepage URL

```
https://github.com/chrisleekr/github-app-playground
```

- Required. Must be a valid, fully-qualified URL (`https://...`).
- If you do not have a dedicated website, use your repository URL. GitHub uses this field when displaying app details to users who encounter the app during installation.

#### Description _(optional)_

```
AI-powered code review bot — responds to @chrisleekr-bot mentions on PRs and issues.
```

- Shown to users on the app installation page.
- Keep it short and informative. Helps installers understand what permissions the app will request.

---

### 1.3 Webhook Configuration

Webhooks are how GitHub pushes events to your server. This section appears **before** the Permissions section in the form.

#### Active

- **Check this box.** It enables webhook delivery.
- Without it, GitHub will not send any events to your server, and the bot will never be triggered.

#### Webhook URL

```
https://github.chrislee.local/api/github/webhooks
```

- The URL GitHub will POST events to. Must be publicly reachable over HTTPS.
- The path `/api/github` is set by the `pathPrefix` option in `createNodeMiddleware` inside `src/app.ts`. Do not change the path unless you also update the source code.
- **During local development**, use a tunnelling tool to expose `localhost:3000`:

  ```bash
  # Option A — ngrok (https://ngrok.com)
  ngrok http 3000
  # Paste the generated https://....ngrok.io URL here

  # Option B — smee.io (https://smee.io)
  smee --url https://smee.io/<your-channel> --path /api/github/webhooks --port 3000
  # Paste the https://smee.io/<your-channel> URL here
  ```

#### SSL verification

- Leave **Enable SSL verification** checked (the default).
- GitHub strongly recommends SSL verification. It confirms the webhook URL's TLS certificate is valid before delivering events.
- Only disable this if you are using a self-signed certificate in a controlled environment.

#### Webhook secret

Generate a random secret:

```bash
openssl rand -hex 32
```

- Copy the output and paste it into this field.
- **Save this value** — you will need it as `GITHUB_WEBHOOK_SECRET` in your `.env` file.
- GitHub uses this secret to sign every webhook payload with HMAC-SHA256. The app verifies the signature via `createNodeMiddleware` from `octokit` before processing any event.
- Without a secret, anyone who knows your webhook URL could send forged events to your server.

> See [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) for how the HMAC-SHA256 signature verification works.

---

### 1.4 Identifying and Authorizing Users (OAuth)

This app uses **installation tokens** (server-to-server authentication) only. It never acts on behalf of an individual GitHub user. Leave all OAuth fields at their defaults.

#### Callback URL

- Leave **empty**.
- This field is only needed when your app generates user access tokens via the OAuth web flow. This app does not do that.

#### Request user authorization (OAuth) during installation

- Leave **unchecked**.
- Checking this would redirect every person who installs the app through an OAuth consent screen. This app never needs a user access token.

#### Enable Device Flow

- Leave **unchecked**.
- Device flow is used to generate user access tokens for CLI tools. Not applicable here.

#### Expire user authorization tokens

- Leave at default (checked, i.e. tokens expire).
- This field has no effect since user authorization is not used.

> For background on installation tokens vs user access tokens, see [About authentication with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app).

---

### 1.5 Post Installation

#### Setup URL _(optional)_

- Leave **empty**.
- This URL is where GitHub redirects users after they install the app, if you need to show a post-install configuration page. Not required for this app.

#### Redirect on update

- Leave **unchecked**.
- Only relevant if you use a Setup URL and want to re-run setup whenever a user modifies the installation (e.g. adds/removes repositories).

---

### 1.6 Permissions

Under **Permissions & events**, expand the **Repository permissions** section and set the following. Leave everything else at **No access**.

#### Repository permissions

| Permission        | Setting      | Why                                                                 |
| ----------------- | ------------ | ------------------------------------------------------------------- |
| **Actions**       | Read-only    | The app can read actions to the repository                          |
| **Contents**      | Read & Write | The app clones the repo and can push commits via the git CLI        |
| **Issues**        | Read & Write | Read issue body and comments; post bot replies as issue comments    |
| **Pull requests** | Read & Write | Read PR diff and context; post review comments and general comments |
| **Metadata**      | Read-only    | **Auto-granted** — required for all GitHub Apps, cannot be removed  |
| **Workflows**     | Read & Write | The app can read/write workflows to the repository                  |

> **Principle of least privilege**: Only request permissions your app actually uses. Requesting unnecessary permissions increases the blast radius if credentials are compromised. See [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app).

#### Organization permissions

- Leave all at **No access**. Not needed.

#### Account permissions

- Leave all at **No access**. Not needed.

---

### 1.7 Subscribe to Events

After you set permissions, the **Subscribe to events** section becomes available and lists only events that match the permissions you granted. Check all five:

| Event checkbox in GitHub UI      | Action(s) handled                                                               | Handler file                           |
| -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **Issue comments**               | `issue_comment.created`                                                         | `src/webhook/events/issue-comment.ts`  |
| **Pull requests**                | `pull_request.opened`                                                           | `src/webhook/events/pull-request.ts`   |
| **Pull request reviews**         | `pull_request_review.submitted`                                                 | `src/webhook/events/review.ts`         |
| **Pull request review comments** | `pull_request_review_comment.created`                                           | `src/webhook/events/review-comment.ts` |
| **Pull request review threads**  | `pull_request_review_thread.resolved` / `pull_request_review_thread.unresolved` | `src/webhook/events/review-thread.ts`  |

> **Note:** GitHub does **not** emit a `pull_request_review_thread.created` action. The only valid actions for this event are `resolved` and `unresolved`, confirmed by `PullRequestReviewThreadResolvedEvent` and `PullRequestReviewThreadUnresolvedEvent` in `@octokit/webhooks-types`. Both actions route to the same handler.
>
> The `pull-request.ts`, `review.ts`, and `review-thread.ts` handlers are **placeholders** — they log the event but take no further action. Implement `processRequest()` inside each when ready.

Leave all other events **unchecked**. Every subscribed event that your server does not handle still generates an HTTP POST to your webhook URL, wastes bandwidth, and creates noise in the **Advanced** delivery log.

> Full list of available webhook events: [Webhook events and payloads](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads)

---

### 1.8 Where Can This GitHub App Be Installed?

This is the last section before the submit button:

| Option                   | When to use                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| **Only on this account** | Personal or single-org use — recommended for private deployments     |
| **Any account**          | You plan to share the app publicly with other users or organizations |

For a private bot deployment, select **Only on this account**.

---

### 1.9 Submit the Form

Click **Create GitHub App**.

GitHub will:

1. Register the app and assign it a unique **App ID**
2. Redirect you to the app's **General settings** page
3. Show a green confirmation banner

You are now on the app settings page. **Do not close this tab** — the next steps require values from this page.

---

## 2. Generate a Private Key

The private key is used to sign JWT tokens that authenticate the app to the GitHub API. Without it, the app cannot generate installation tokens.

### Step-by-step

1. On the app's **General settings** page (where you landed after creation), scroll down to the **Private keys** section near the bottom of the page.
2. Click **Generate a private key**.
3. GitHub generates an RSA-2048 key pair, keeps the public key, and immediately downloads the private key as a `.pem` file to your computer (e.g. `chrisleekr-bot.2026-02-18.private-key.pem`).
4. Move the file somewhere secure — a password manager, a secrets vault, or an encrypted disk. **Never commit this file to Git.**

### What the private key looks like

```
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29R2rFTmMjP8sP
...  (many lines of base64)
-----END RSA PRIVATE KEY-----
```

The entire content of the file — including the `-----BEGIN` and `-----END` header/footer lines — must be stored as the `GITHUB_APP_PRIVATE_KEY` environment variable. When setting this in a single-line environment file, replace each newline with a literal `\n`:

```bash
# Single-line format for .env files
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n"
```

Or keep the file on disk and read it at runtime:

```bash
# Shell — expand to a single line with \n escape sequences
export GITHUB_APP_PRIVATE_KEY="$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' chrisleekr-bot.private-key.pem)"
```

> See [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) for key rotation and revocation procedures.

---

## 3. Note the App ID

Still on the app's **General settings** page:

1. Scroll to the very top, to the **About** section.
2. Find the **App ID** field — it is a short integer, e.g. `123456`.
3. Save this value — you will need it as `GITHUB_APP_ID` in your `.env` file.

The App ID is also visible in the URL when you are on the app settings page:

```
https://github.com/settings/apps/chrisleekr-bot
                                  ^^^^^^^^^^^^^^^^ — this is your app slug, not the ID
```

The numeric ID is only shown in the **About** section or returned by the API (`GET /app`).

---

## 4. Install the App on Repositories

The app is now registered but not yet installed on any repository. A GitHub App only receives webhook events and can only access resources for repositories where it is installed.

### Step-by-step

1. In the left sidebar of your app settings, click **Install App**.
2. You will see a list of accounts (your personal account and any organizations you own or manage). Click **Install** next to the account where you want the bot to be active.
3. A confirmation screen asks which repositories to grant access to:

   | Option                       | Effect                                                             |
   | ---------------------------- | ------------------------------------------------------------------ |
   | **All repositories**         | App can access every current and future repository on this account |
   | **Only select repositories** | App is limited to repositories you explicitly choose (recommended) |

4. If you chose **Only select repositories**, use the search box to find and select each target repository.
5. Click **Install**.

GitHub will redirect you to the installation's settings page. The URL contains the **Installation ID** — save it if you need it for debugging (it is not required for normal operation; `octokit` resolves it automatically from the webhook payload).

> After installation, the bot will respond to `@chrisleekr-bot` mentions **only** in the repositories where the app is installed. Mentions in other repositories are silently ignored.

### Verify installation

Go to any installed repository and check **Settings > GitHub Apps**. You should see `chrisleekr-bot` listed with the access level you granted.

---

## 5. Local Development

### Install dependencies

```bash
bun install
```

### Copy and fill in environment variables

```bash
cp .env.example .env
# Edit .env with your values — see Section 9 for the full variable reference
```

### Run in development mode (watch)

```bash
bun run dev
```

This starts the HTTP server on `PORT` (default `3000`) and restarts on file changes.

### Run tests

```bash
bun test                 # run once
bun run test:watch       # re-run on file changes
bun run test:coverage    # with coverage report
```

### Other useful commands

```bash
bun run typecheck        # TypeScript strict type check (no emit)
bun run lint             # ESLint check
bun run lint:fix         # ESLint auto-fix
bun run format           # Prettier format check
bun run format:fix       # Prettier auto-fix
```

### Expose the local server for webhook delivery

GitHub must reach your webhook URL over the internet. During development, use a tunnelling tool such as [ngrok](https://ngrok.com) or [smee.io](https://smee.io):

```bash
# Example with ngrok
ngrok http 3000
# Copy the forwarding URL and paste it into the GitHub App webhook settings
```

---

## 6. Configure Environment Variables

Copy `.env.example` and fill in the values:

```bash
cp .env.example .env
```

All variables are validated at startup by `zod` in `src/config.ts`. The process exits immediately with a clear error message if any required variable is missing or invalid.

### GitHub App credentials (always required)

| Variable                 | Source                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`          | App settings page, **About** section                                                |
| `GITHUB_APP_PRIVATE_KEY` | Full contents of the downloaded `.pem` file (including `-----BEGIN/END-----` lines) |
| `GITHUB_WEBHOOK_SECRET`  | The value you generated with `openssl rand -hex 32` during registration             |

### AI provider selection

| Variable          | Default         | Allowed values                                            | Description                                                                                                                                                        |
| ----------------- | --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE_PROVIDER` | `anthropic`     | `anthropic` \| `bedrock`                                  | Selects which backend Claude runs on                                                                                                                               |
| `CLAUDE_MODEL`    | _(SDK default)_ | e.g. `claude-opus-4-5` / `us.anthropic.claude-sonnet-4-6` | Override the model. **Required** when `CLAUDE_PROVIDER=bedrock` because Bedrock uses a different model ID format than the Anthropic API. Optional for `anthropic`. |

### Anthropic API (required when `CLAUDE_PROVIDER=anthropic`)

| Variable            | Source                                                         |
| ------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | [https://console.anthropic.com](https://console.anthropic.com) |

### Amazon Bedrock (required when `CLAUDE_PROVIDER=bedrock`)

See [Section 7](#7-amazon-bedrock-configuration) for the full credential setup guide.

| Variable                     | Required | Description                                                                 |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `AWS_REGION`                 | Yes      | AWS region with Bedrock access, e.g. `us-east-1`                            |
| `AWS_PROFILE`                | No       | Local AWS SSO profile (credential method 1 — local dev)                     |
| `AWS_ACCESS_KEY_ID`          | No       | Explicit IAM access key (credential method 2 — CI/CD)                       |
| `AWS_SECRET_ACCESS_KEY`      | No       | Paired with `AWS_ACCESS_KEY_ID`                                             |
| `AWS_SESSION_TOKEN`          | No       | Session token for temporary/assumed-role credentials                        |
| `AWS_BEARER_TOKEN_BEDROCK`   | No       | OIDC bearer token (credential method 3 — GitHub Actions)                    |
| `ANTHROPIC_BEDROCK_BASE_URL` | No       | Override Bedrock endpoint, e.g. for VPC endpoints or cross-region inference |

### Optional variables

| Variable                  | Default               | Description                                                                                                                                                   |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT7_API_KEY`        | _(none)_              | Higher rate limits for library docs via Context7 MCP server ([context7.com/dashboard](https://context7.com/dashboard)). Without a key the server is disabled. |
| `CLONE_BASE_DIR`          | `/tmp/bot-workspaces` | Base directory for temporary repo clones.                                                                                                                     |
| `TRIGGER_PHRASE`          | `@chrisleekr-bot`     | Mention phrase that activates the bot. Change this to match your app name.                                                                                    |
| `PORT`                    | `3000`                | HTTP server port                                                                                                                                              |
| `LOG_LEVEL`               | `info`                | Pino log level: `fatal` / `error` / `warn` / `info` / `debug` / `trace`                                                                                       |
| `NODE_ENV`                | `production`          | Runtime environment: `production` / `development` / `test`                                                                                                    |
| `MAX_CONCURRENT_REQUESTS` | `3`                   | Maximum simultaneous Claude agent executions. Prevents API budget exhaustion and CPU/memory saturation in the pod.                                            |

---

## 7. Amazon Bedrock Configuration

Set `CLAUDE_PROVIDER=bedrock` and `CLAUDE_MODEL=<bedrock-model-id>` (e.g. `us.anthropic.claude-sonnet-4-6`).
`AWS_REGION` is also required. Then choose **one** credential method:

### Credential method 1 — Local dev (AWS SSO profile)

```bash
# Authenticate with SSO first
aws sso login --profile default   # or your custom profile name

# Set the profile in .env
AWS_PROFILE=default
```

The Claude Code subprocess inherits the profile via the AWS SDK credential chain automatically.

### Credential method 2 — Explicit access keys (CI/CD or non-SSO)

```bash
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...   # only for temporary/assumed-role credentials
```

### Credential method 3 — OIDC bearer token (GitHub Actions)

Use [aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials) in your workflow, then set:

```bash
AWS_BEARER_TOKEN_BEDROCK=<token>
```

### Bedrock IAM policy

The IAM role or user needs at minimum:

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
  "Resource": "arn:aws:bedrock:<region>::foundation-model/anthropic.claude-*"
}
```

See [Amazon Bedrock identity-based policy examples](https://docs.aws.amazon.com/bedrock/latest/userguide/security_iam_id-based-policy-examples.html).

---

## 8. Verify the Setup

### Test webhook delivery

1. Go to **Settings > Developer settings > GitHub Apps > your app > Advanced**
2. Click **Redeliver** on a recent delivery, or trigger a new one by posting a comment
3. Check the app logs for a successful signature verification message

### End-to-end test

1. Open an issue or PR in a repository where the app is installed
2. Post a comment: `@chrisleekr-bot what does this repo do?`
3. The bot creates a tracking comment and begins replying

### Troubleshooting

| Symptom                               | Check                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Webhook returns 401/403               | `GITHUB_WEBHOOK_SECRET` must exactly match the value set in app settings (no trailing newline)                   |
| Bot does not respond                  | Confirm the app is installed on the target repository; check that the subscribed events match the comment type   |
| `GITHUB_APP_PRIVATE_KEY` error        | Set the full `.pem` contents including `-----BEGIN RSA PRIVATE KEY-----` / `-----END RSA PRIVATE KEY-----` lines |
| Webhook timeout (> 10 s on GitHub)    | Processing runs async after `200 OK`; check pod logs for errors — GitHub may show timeout but work proceeds      |
| `ANTHROPIC_API_KEY is required`       | `CLAUDE_PROVIDER` defaults to `anthropic`; set `ANTHROPIC_API_KEY` or switch to `bedrock`                        |
| `AWS_REGION is required`              | Set `AWS_REGION` when `CLAUDE_PROVIDER=bedrock`                                                                  |
| `CLAUDE_MODEL is required`            | Bedrock uses a different model ID format; set e.g. `CLAUDE_MODEL=us.anthropic.claude-sonnet-4-6`                 |
| Bedrock `UnrecognizedClientException` | AWS credentials are missing or expired; verify the credential method in use (see Section 8)                      |
| Pod OOM killed                        | Reduce `MAX_CONCURRENT_REQUESTS` or increase the memory available to the process                                 |
| `/readyz` returns 503                 | Server is shutting down (SIGTERM received); a restart is in progress — normal during graceful shutdown           |
| Clone directory full                  | `CLONE_BASE_DIR` is out of disk space; reduce `MAX_CONCURRENT_REQUESTS` or free up disk                          |
| Context7 server not active            | `CONTEXT7_API_KEY` is empty or unset; without a key the Context7 MCP server is disabled automatically            |
