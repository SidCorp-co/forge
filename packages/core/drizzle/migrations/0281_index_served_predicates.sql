CREATE INDEX "knowledge_entries_embedding_backfill_idx" ON "knowledge_entries" USING btree ("updated_at") WHERE embedding IS NULL AND archived_at IS NULL;--> statement-breakpoint
CREATE INDEX "memories_embedding_backfill_idx" ON "memories" USING btree ("updated_at") WHERE embedding IS NULL;--> statement-breakpoint
CREATE INDEX "phase_journal_runner_verdicts_idx" ON "phase_journal" USING btree ("run_id","started_at") WHERE source = 'runner' AND artifact ->> 'kind' = 'verdict';--> statement-breakpoint

-- ===========================================================================
-- Everything above this line is drizzle-kit's, generated from db/schema.ts and
-- db/schema-journal.ts. Everything below is DB-level only, for the same reason
-- `pipeline_outbox` has no index block and 0069's two lookups are not in
-- db/schema.ts: an index keyed on a jsonb EXPRESSION has no drizzle DSL that
-- renders `((metadata->>'issueId'))`, so a mirror in schema.ts would either not
-- compile or make `db:generate` emit a DROP for the real index on every run.
-- The snapshot therefore does not record these three, which is correct and is
-- what keeps `pnpm db:generate` quiet after this lands.
-- ===========================================================================

-- ISS-1023 criterion 30 — `issues/pipeline-health.ts` Q2 and
-- `issues/agent-sessions-hydrator.ts` both filter
-- `metadata->>'issueId' IN (...)`, once on the issue list route and again on
-- the detail route. Live beta 2026-09-17: a Seq Scan removing 21,923 rows over
-- 2,693 shared buffers, 9.99 ms, 31,577 sequential scans accumulated.
--
-- The two live expression indexes from 0069 do NOT serve these: both are keyed
-- `(issueId, sessionGroup)` under `claude_session_id IS NOT NULL` predicates
-- that neither query carries, so the planner cannot prove implication and
-- falls back to the scan without saying anything.
--
-- The `IS NOT NULL` predicate is what makes this small — a session with no
-- issueId (interactive, pm, schedule.run) is not reachable by either reader.
CREATE INDEX IF NOT EXISTS "agent_sessions_metadata_issue_id_idx"
  ON "agent_sessions" ((metadata->>'issueId'))
  WHERE metadata->>'issueId' IS NOT NULL;--> statement-breakpoint

-- ISS-1023 criterion 31 — `schedules/service.ts` listScheduleRuns looks a
-- schedule's sessions up by equality on `metadata->>'scheduleId'` and orders by
-- `created_at DESC`, and carries NO `source` term, so an index predicated on
-- `source = 'schedule.run'` could not be proven implied here. The predicate is
-- `scheduleId IS NOT NULL`, which that query does imply.
CREATE INDEX IF NOT EXISTS "agent_sessions_metadata_schedule_id_idx"
  ON "agent_sessions" ((metadata->>'scheduleId'), created_at DESC)
  WHERE metadata->>'scheduleId' IS NOT NULL;--> statement-breakpoint

-- ISS-1023 criterion 32 — A SECOND index, and the one above genuinely does not
-- replace it. ISS-1021's decision record says one `scheduleId IS NOT NULL`
-- index serves both readers because both match that predicate; matching is not
-- being chosen, and EXPLAIN refuted it. A5 has no equality on `scheduleId` at
-- all, so the index above offers it no index condition — only a whole-index
-- read whose cost the planner put above a sequential scan, and the A5 plan came
-- back byte-identical with the index present and dropped: `Seq Scan on
-- agent_sessions ... Rows Removed by Filter: 21608, Buffers: shared hit=1218`
-- either way. See the correction on ISS-1021.
--
-- Predicating on `source = 'schedule.run'` instead makes the index EXACTLY the
-- set A5 reads — 400 of 22,000 rows — which is the estimate the planner needed:
-- `Bitmap Index Scan on agent_sessions_schedule_run_idx (actual rows=400)`,
-- 17.6 ms down to 3.3 ms. The key shape is the one `alert-queries.ts`' own
-- cm:guard names, `(metadata ->> 'scheduleId', updated_at)`.
CREATE INDEX IF NOT EXISTS "agent_sessions_schedule_run_idx"
  ON "agent_sessions" ((metadata->>'scheduleId'), updated_at)
  WHERE metadata->>'source' = 'schedule.run';--> statement-breakpoint

-- ISS-1021 criteria 19 and 21 — 0070 created this index predicated on
-- `processed_at IS NULL` alone, which is NOT the set the claim reads. A row
-- that has exhausted `MAX_REDELIVERIES` stays `processed_at IS NULL` by
-- design (dead-lettered, kept for a human), so it lives in the index forever
-- and every one of ~86,400 polls a day sorts it to the front and steps over
-- it. Live beta 2026-09-17: exactly one unprocessed row, and it is that row.
--
-- The `3` here is `MAX_REDELIVERIES` in src/pipeline/outbox-worker.ts, which
-- is rendered into the claim as a LITERAL for exactly this reason (see the
-- cm:guard there). The two cannot be generated from one place across a SQL
-- file and a TS module, so tests/integration/outbox-index-predicate.test.ts asserts
-- they still agree, against the effective definition in pg_indexes.
DROP INDEX IF EXISTS "idx_outbox_unprocessed";--> statement-breakpoint
CREATE INDEX "idx_outbox_unprocessed"
  ON "pipeline_outbox" ("created_at")
  WHERE "processed_at" IS NULL AND "attempts" < 3;
