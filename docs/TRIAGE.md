# AI Triage

Triage is a binary `heavy` classifier. It runs on every event (subject to the kill-switch and circuit breaker) and answers one question: should this job prefer an ephemeral daemon?

## When it runs

1. The event hits the router.
2. The orchestrator calls a single-turn Haiku classifier.
3. On success, the returned `heavy` boolean feeds into the [scale-up rule](ARCHITECTURE.md#scale-up-model): `heavy=true` is one of the two triggers that can cause the orchestrator to spawn an ephemeral daemon Pod. `heavy=false` routes the job to `persistent-daemon`.

## What the call returns

A small JSON object: `{ heavy: boolean, confidence: number, rationale: string }`. There is no `complexity` field and no `maxTurns` mapping — `maxTurns` always comes from `config.defaultMaxTurns` regardless of the triage outcome.

## Confidence threshold

At or above `TRIAGE_CONFIDENCE_THRESHOLD`, `heavy` is accepted as-is. Below it, the router treats the signal as `heavy=false` — the job routes to `persistent-daemon` and the log line carries `triage_fallback_reason=sub-threshold`. The day-one default is `1.0` so only perfectly confident results are accepted.

## Circuit breaker

Triage wraps the LLM call in a circuit breaker (see `src/orchestrator/triage.ts`). Consecutive failures trip the breaker; while it is open, the triage function short-circuits to `heavy=false` and emits `triage_fallback_reason=circuit-open`. The breaker re-closes after a cooldown.

## Fallback reasons

Six distinct reasons cause triage to fall back to `heavy=false` (i.e. route to `persistent-daemon`):

| Reason          | Trigger                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `disabled`      | `TRIAGE_ENABLED=false` — triage short-circuits without calling the LLM. |
| `circuit-open`  | The circuit breaker tripped after consecutive failures.                 |
| `timeout`       | The call exceeded `TRIAGE_TIMEOUT_MS`.                                  |
| `llm-error`     | The provider returned an error.                                         |
| `parse-error`   | The JSON response could not be validated against the expected schema.   |
| `sub-threshold` | Parsed successfully but `confidence < TRIAGE_CONFIDENCE_THRESHOLD`.     |

All six appear in Pino logs as `triage_fallback_reason`. Canonical values live in `src/orchestrator/triage.ts`.

## Cost implications

Every event incurs one Haiku call. For a busy install, that is the dominant marginal cost. Mitigations:

- Raise `TRIAGE_CONFIDENCE_THRESHOLD` (default `1.0`) to accept fewer heavy verdicts — cheaper in compute terms but will route more borderline jobs to the persistent pool.
- Flip `TRIAGE_ENABLED=false` during a provider incident to suppress spend without redeploying. While disabled, every event is treated as `heavy=false`.
- Keep `TRIAGE_MAX_TOKENS` low (the response schema is ~40 tokens).

## Tuning knobs

| Variable                      | Default     | When to change                                                           |
| ----------------------------- | ----------- | ------------------------------------------------------------------------ |
| `TRIAGE_ENABLED`              | `true`      | Incident kill-switch.                                                    |
| `TRIAGE_MODEL`                | `haiku-3-5` | Experiment with newer Haiku aliases for latency.                         |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`       | Relax to `0.8`–`0.9` once you're confident the classifier is calibrated. |
| `TRIAGE_MAX_TOKENS`           | `256`       | Only raise if the rationale is being truncated.                          |
| `TRIAGE_TIMEOUT_MS`           | `5000`      | Raise if provider latency is consistently above 5s.                      |
| `DEFAULT_MAXTURNS`            | `30`        | Agent turn cap for every execution.                                      |

Full variable descriptions live in [Configuration](CONFIGURATION.md#triage).
