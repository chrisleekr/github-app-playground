# AI Triage

Triage runs **only** in auto mode (`AGENT_JOB_MODE=auto`) and **only** after the deterministic label/keyword classifier returns "ambiguous". Every other path — explicit label, keyword match, non-auto mode — returns a target without an LLM call.

## When it runs

1. The event hits the router.
2. The static cascade looks at labels, then at keywords in the mention body.
3. If both are inconclusive **and** `AGENT_JOB_MODE=auto`, a single-turn Haiku call classifies the request. Otherwise the router returns `DEFAULT_DISPATCH_TARGET` directly.

## What the call returns

A small JSON object: `{ mode, confidence, complexity, rationale }`. The `mode` is one of the four [dispatch targets](ARCHITECTURE.md#targets). `complexity` is `trivial`, `moderate`, or `complex` and maps to `TRIAGE_MAXTURNS_TRIVIAL`, `TRIAGE_MAXTURNS_MODERATE`, or `TRIAGE_MAXTURNS_COMPLEX` respectively.

## Confidence threshold

Above or equal to `TRIAGE_CONFIDENCE_THRESHOLD`, the returned `mode` is accepted — logged as `dispatch_reason=triage`. Below it, the router falls back to `DEFAULT_DISPATCH_TARGET` and records `dispatch_reason=default-fallback`. The day-one default is `1.0` so only perfectly confident results are accepted.

## Fallback reasons

Six distinct reasons cause triage to fall back to `DEFAULT_DISPATCH_TARGET`:

| Reason          | Trigger                                                               |
| --------------- | --------------------------------------------------------------------- |
| `disabled`      | `TRIAGE_ENABLED=false`. Kill-switch.                                  |
| `circuit-open`  | The circuit breaker tripped after consecutive failures.               |
| `timeout`       | The call exceeded `TRIAGE_TIMEOUT_MS`.                                |
| `llm-error`     | The provider returned an error.                                       |
| `parse-error`   | The JSON response could not be validated against the expected schema. |
| `sub-threshold` | Parsed successfully but `confidence < TRIAGE_CONFIDENCE_THRESHOLD`.   |

All six appear in Pino logs as `triage_fallback_reason` on the same event that carries `dispatch_reason=default-fallback` or `triage-error-fallback`. Canonical values live in `src/orchestrator/triage.ts`.

## Cost implications

Every auto-mode request whose static cascade is ambiguous incurs one Haiku call. For a busy install, that's the dominant marginal cost. Mitigations:

- Raise `TRIAGE_CONFIDENCE_THRESHOLD` (default `1.0`) to force more fallbacks — cheaper but shifts the decision onto `DEFAULT_DISPATCH_TARGET`.
- Flip `TRIAGE_ENABLED=false` during a provider incident to suppress spend without redeploying.
- Keep `TRIAGE_MAX_TOKENS` low (the response schema is ~60 tokens).

## Tuning knobs

| Variable                      | Default        | When to change                                                           |
| ----------------------------- | -------------- | ------------------------------------------------------------------------ |
| `TRIAGE_ENABLED`              | `true`         | Incident kill-switch.                                                    |
| `TRIAGE_MODEL`                | `haiku-3-5`    | Experiment with newer Haiku aliases for latency.                         |
| `TRIAGE_CONFIDENCE_THRESHOLD` | `1.0`          | Relax to `0.8`–`0.9` once you're confident the classifier is calibrated. |
| `TRIAGE_MAX_TOKENS`           | `256`          | Only raise if the rationale is being truncated.                          |
| `TRIAGE_TIMEOUT_MS`           | `5000`         | Raise if provider latency is consistently above 5s.                      |
| `TRIAGE_MAXTURNS_*`           | `10 / 30 / 50` | Tune per-complexity agent budgets independently.                         |
| `DEFAULT_MAXTURNS`            | `30`           | Fallback budget when triage is not consulted.                            |

Full variable descriptions live in [Configuration](CONFIGURATION.md#triage-auto-mode).
