-- ISS-439 — backfill usage_records for historical CLI-runner jobs from the
-- job_events core already stores (rows reach back to ~2026-05-12). Mirrors the
-- go-forward extractor in usage-records/from-job-events.ts: take each job's
-- LAST stdout `result` line, read the flat snake_case usage token fields and
-- the authoritative `total_cost_usd`, attribute the model from the first
-- assistant `message.model`. source='cli', session_id = job.agent_session_id.
--
-- Idempotent: ON CONFLICT on the job_id partial unique index → re-running is a
-- no-op, and it skips any job that already has a materialized row (e.g. one the
-- go-forward path wrote post-deploy). Desktop jobs stream no stdout events, so
-- the result-line join excludes them — the desktop ingest path is never
-- double-counted.
INSERT INTO "usage_records" (
  "project_id", "source", "model",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
  "estimated_cost", "request_count", "session_id", "job_id", "recorded_at"
)
SELECT
  j."project_id",
  'cli',
  COALESCE(am."model", 'unknown'),
  COALESCE((r."line" -> 'usage' ->> 'input_tokens')::int, 0),
  COALESCE((r."line" -> 'usage' ->> 'output_tokens')::int, 0),
  COALESCE((r."line" -> 'usage' ->> 'cache_read_input_tokens')::int, 0),
  COALESCE((r."line" -> 'usage' ->> 'cache_creation_input_tokens')::int, 0),
  COALESCE((r."line" ->> 'total_cost_usd')::float8, 0),
  COALESCE((r."line" ->> 'num_turns')::int, 1),
  j."agent_session_id"::text,
  j."id",
  r."ts"
FROM "jobs" j
JOIN LATERAL (
  SELECT (je."data" -> 'line') AS "line", je."ts" AS "ts"
  FROM "job_events" je
  WHERE je."job_id" = j."id"
    AND je."kind" = 'stdout'
    AND je."data" -> 'line' ->> 'type' = 'result'
  ORDER BY je."seq" DESC
  LIMIT 1
) r ON true
LEFT JOIN LATERAL (
  SELECT je."data" -> 'line' -> 'message' ->> 'model' AS "model"
  FROM "job_events" je
  WHERE je."job_id" = j."id"
    AND je."kind" = 'stdout'
    AND je."data" -> 'line' ->> 'type' = 'assistant'
    AND je."data" -> 'line' -> 'message' ->> 'model' IS NOT NULL
  ORDER BY je."seq" ASC
  LIMIT 1
) am ON true
WHERE j."agent_session_id" IS NOT NULL
ON CONFLICT ("job_id") WHERE "job_id" IS NOT NULL DO NOTHING;
