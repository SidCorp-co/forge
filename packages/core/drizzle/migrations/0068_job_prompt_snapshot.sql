-- S1.1 — Prompt snapshot storage for Surface A (Prompt Inspector) +
-- Surface C (Analytics). Captures what the orchestrator built at enqueue
-- time so we can audit prompts after the fact, diff runs, and aggregate
-- block contribution per state.
--
-- System prompt is content-addressable (sha256 → prompt_blobs) because it
-- is stable across jobs of the same project — dedup saves ~70% storage vs
-- inlining. User prompt is per-issue dynamic, so inline.
--
-- Reversible: drop columns + table, no data migration.

-- Storage for deduplicated system prompts. Many jobs of the same project
-- share the same preamble (PIPELINE_RULES + TOOL_REFERENCE + branches), so
-- we keep one row per unique hash and reference-count via the FK.
CREATE TABLE IF NOT EXISTS "prompt_blobs" (
  "hash"       text PRIMARY KEY,
  "content"    text NOT NULL,
  "first_seen" timestamptz NOT NULL DEFAULT now(),
  "ref_count"  integer NOT NULL DEFAULT 0
);

-- Per-job snapshot columns. system_prompt_hash points at prompt_blobs;
-- user_prompt_snapshot is the rendered `/skill id + ## Issue + ## Previous
-- Session Context` string sent verbatim to the runner. prompt_blocks is a
-- structured breakdown for analytics (per-block char + token count).
-- archive_path is set by the nightly archival cron once snapshot rows are
-- older than FORGE_PROMPT_RETENTION_DAYS.
ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "system_prompt_hash"     text REFERENCES "prompt_blobs"("hash"),
  ADD COLUMN IF NOT EXISTS "user_prompt_snapshot"   text,
  ADD COLUMN IF NOT EXISTS "prompt_input_token_est" integer,
  ADD COLUMN IF NOT EXISTS "model_used"             text,
  ADD COLUMN IF NOT EXISTS "prompt_blocks"          jsonb,
  ADD COLUMN IF NOT EXISTS "archive_path"           text;

-- Partial index for the archival sweeper: finds finished jobs that haven't
-- been archived yet. Partial keeps the index small (covers only the
-- live-but-aging tail, not the whole jobs table).
CREATE INDEX IF NOT EXISTS "jobs_finished_archive_idx"
  ON "jobs" ("finished_at")
  WHERE "archive_path" IS NULL AND "finished_at" IS NOT NULL;
