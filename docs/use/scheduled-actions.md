# Scheduled actions

The bot can run **prompt-based actions on a cron schedule**, unattended, in
addition to reacting to `@chrisleekr-bot` mentions and `bot:*` labels.

A GitHub App receives no native cron event, so the bot runs its own internal
scheduler inside the webhook server. Each scan it enumerates installed repos,
reads a `.github-app.yaml` from each, and enqueues any action whose cron slot
is due. The daemon fleet runs each action as a single agent session.

## Enabling

Scheduled actions run only when the operator has set:

- `SCHEDULER_ENABLED=true`
- `DATABASE_URL` configured
- a non-empty `ALLOWED_OWNERS` (the action prompt is owner-trusted config, so
  the feature refuses to start without an owner allowlist)

See [Configuration](../operate/configuration.md#scheduled-actions).

## `.github-app.yaml`

Place the file at your repo's **default-branch root**.

```yaml
version: 1

config:
  timezone: "Australia/Melbourne" # IANA tz for cron evaluation; default "UTC"

scheduled_actions:
  - name: research # unique per file; [a-z0-9-], 1-64 chars
    cron: "0 3 * * *" # standard 5-field cron, evaluated in config.timezone
    timezone: "UTC" # optional per-action override of config.timezone
    enabled: true
    model: "opus" # optional; defaults to the bot's CLAUDE_MODEL
    max_turns: 200 # optional; agent turn cap, 1-500
    timeout: 60m # optional; wall-clock ceiling (ms or Nh/Nm/Ns)
    auto_merge: false # see "Auto-merge" below
    allowed_tools: # optional; defaults to a read-only set
      - WebSearch
      - WebFetch
      - Read
      - "Bash(gh issue create:*)"
    prompt:
      ref: ".github/skills/research.md"
```

A malformed file fails validation and the whole repo is skipped for that scan
(logged); a valid file never partially applies.

## Prompt forms

`prompt` is exactly one of:

| Form   | YAML                                              | Behaviour                                                                     |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| inline | `prompt: { inline: "..." }`                       | The text is the prompt verbatim.                                              |
| file   | `prompt: { ref: "path/to/file.md" }`              | The file's contents are the prompt.                                           |
| folder | `prompt: { ref: "dir/", entrypoint: "SKILL.md" }` | Entrypoint + one level of sibling files, concatenated with `=== FILE: … ===`. |

Add `repo: "owner/name"` to a `ref` to source the prompt from another repo the
App is installed on. That owner must also be in `ALLOWED_OWNERS`.

## How a run executes

The scheduler is dumb: it only fires the prompt. The agent does all the work
the prompt describes, pick an issue, triage, label, open a PR, etc., as one
agent session, with the action's `model`, `max_turns`, `timeout`, and
`allowed_tools`. It is a separate execution path from the `bot:ship` workflow.

- **Missed slots are skipped.** If the server is down across a cron slot, that
  slot is dropped (the next slot still fires): a daily action down for three
  days runs once, not three times.
- **Single-flight.** A new run is skipped while the action's previous run is
  still in-flight (the lock self-heals after a stale window).
- **Multi-replica safe.** A compare-and-swap slot claim means replicas never
  double-fire.

## Auto-merge

When an action sets `auto_merge: true` **and** the operator has set
`SCHEDULER_ALLOW_AUTO_MERGE=true`, the daemon exposes a `merge_readiness` MCP
tool (`check_merge_readiness`). It wraps the deterministic merge-readiness
verdict used by `bot:ship` (CI green, no conflicts, no open review threads, no
human takeover). The skill prompt is expected to call it and merge only when
the verdict is `ready` **and** the agent is confident.

`merge_readiness` only _reports_ readiness: it does not merge. For the agent
to actually merge, the action's `allowed_tools` must additionally include a
merge-capable tool (e.g. `"Bash(gh pr merge:*)"`). `auto_merge: true` with the
default read-only tool set gates a merge it cannot perform.

Both switches default off. The verdict bounds _mergeability_, not
_correctness_: a scheduled action that merges still trusts the LLM's judgement
on whether the change is right. Keep `SCHEDULER_ALLOW_AUTO_MERGE` off unless
you accept that.

## Trust model

`.github-app.yaml`, the prompt, and `allowed_tools` are editable by anyone with
push access to the repo, so they are treated as **trusted-as-owner config**,
the same trust tier as a `.github/workflows/` file. The owner-allowlist gate is
load-bearing: scheduled actions run only for `ALLOWED_OWNERS` repos.

A cross-repo prompt `ref` (`repo: "owner/name"`) is honoured only when that
owner is also allowlisted. Note the boundary is the **owner**, not the repo: a
contributor with push access to repo A can source a prompt from any other repo
the same allowlisted owner controls that the installation can read. Keep prompt
sources within trust you already extend to that owner.

## Manual trigger

Operators can force one action to run immediately, bypassing the cron check:

```
curl -X POST https://<bot-host>/api/scheduler/run \
  -H "Authorization: Bearer $DAEMON_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"owner":"chrisleekr","repo":"github-app-playground","action":"research"}'
```

Returns `202` when enqueued, `409` when a run is already in-flight, `404` when
the scheduler is disabled, `401` on a bad token.

## The `research` action

This repo ships a `research` action: the in-App replacement for the
`.github/workflows/research.yml` GitHub Actions workflow. The skill prompt is
`.github/skills/research.md`; a copyable example is under
`examples/scheduled-actions/`. It runs at 05:00 AEST, **2 hours after**
`research.yml`'s 03:00 slot, so while both are live they never overlap. The
cutover is to verify the action in production, then delete `research.yml`.
