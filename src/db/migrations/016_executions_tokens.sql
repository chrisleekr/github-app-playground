-- Migration 016: persist Claude Agent SDK token usage on executions (issue #192).
--
-- The executor reads input_tokens / output_tokens / cache_* counters and the
-- per-model modelUsage breakdown from SDKResultMessage.usage, but only
-- cost_usd / duration_ms / num_turns were persisted. Without the token counts
-- an operator cannot tell a 500 KB-prompt / 2-turn run from a 5 KB-prompt /
-- 50-turn run (identical cost_usd), nor compute the prompt-cache hit-ratio
--   cache_read / (input + cache_read + cache_creation)
-- that is the load-bearing signal for prompt-cache stability (#134).
--
-- All columns are nullable and additive: pre-existing rows stay NULL and the
-- existing dispatch_stats aggregates are unaffected.

-- BIGINT (not INTEGER): SDKResultMessage.usage is CUMULATIVE for the whole
-- session, and cache_read_input_tokens in particular accumulates as
-- cached-prompt-size x turns. A long run with a raised turn/budget cap can
-- exceed INTEGER's 2.1B ceiling, which would make the markExecutionCompleted
-- UPDATE throw `integer out of range`. BIGINT (~9.2e18) removes that ceiling.
ALTER TABLE executions
    ADD COLUMN input_tokens                BIGINT NULL,
    ADD COLUMN output_tokens               BIGINT NULL,
    ADD COLUMN cache_read_input_tokens     BIGINT NULL,
    ADD COLUMN cache_creation_input_tokens BIGINT NULL,
    ADD COLUMN model_usage                 JSONB  NULL;
