-- ISS-1021 / ISS-1023 — the way back from 0281_index_served_predicates.sql.
--
-- NOT run by `db/migrate.js`. This file is applied BY HAND, against the database, BEFORE the
-- previous image is started — never after. The previous image's boot migrator knows only its
-- own migrations, so starting it against the new schema makes it loop; and the runtime image
-- installs only openssh-keygen, openssh-client and git, so there is no `psql` inside it.
-- Reach the database from a one-off container on the app's own network:
--
--   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' <core-container>
--   docker run --rm --network <that-network> -i postgres:16 \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     < packages/core/drizzle/rollback/0281_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0281_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted.
--
-- Then:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0281 hash>';
-- and start the previous image.
--
-- WHAT THIS COSTS, AND WHAT IT DOES NOT.
--
-- Nothing is lost. 0281 creates six indexes and replaces the predicate on a seventh; an index
-- holds no value the table does not already hold, and every query 0281 speeds up returns the
-- SAME ROWS without it. So this file is safe to run at any time, including against the NEW
-- image — dropping an index is not a rollback of behaviour, only of speed. That is the property
-- the plan's way-back rests on: an index the planner turns out not to pick can be dropped on its
-- own, without reverting the code half.
--
-- The one statement here that is not a bare DROP is the last pair. 0070 created
-- `idx_outbox_unprocessed` predicated on `processed_at IS NULL` alone, and the previous image's
-- outbox claim carries `attempts < 3` as a literal either way, so restoring the wider predicate
-- restores 0070's behaviour exactly: the dead-lettered rows come back into the index and are
-- stepped over on every poll, which is the defect 0281 closed and not a correctness change.

-- === agent_sessions expression indexes (ISS-1023) ============================
DROP INDEX IF EXISTS "agent_sessions_metadata_issue_id_idx";
DROP INDEX IF EXISTS "agent_sessions_metadata_schedule_id_idx";
DROP INDEX IF EXISTS "agent_sessions_schedule_run_idx";

-- === embedding-backfill partial indexes (ISS-1021) ===========================
DROP INDEX IF EXISTS "memories_embedding_backfill_idx";
DROP INDEX IF EXISTS "knowledge_entries_embedding_backfill_idx";

-- === rejection-streak partial index (ISS-1021) ===============================
DROP INDEX IF EXISTS "phase_journal_runner_verdicts_idx";

-- === the outbox predicate, back to 0070's ====================================
DROP INDEX IF EXISTS "idx_outbox_unprocessed";
CREATE INDEX "idx_outbox_unprocessed"
  ON "pipeline_outbox" ("created_at")
  WHERE "processed_at" IS NULL;
