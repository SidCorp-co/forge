-- ISS-1136 — `agent_sessions` had twenty-five columns and none of them said what
-- species of row it was or which session owned it. Both facts were reconstructed at
-- read time, differently, by each of twenty call sites, and two of the five writers
-- declared no species at all, so a sweep filtering `metadata->>'type'` could not see
-- them. This puts both facts in columns core writes.
--
-- The inference below runs ONCE and is frozen, instead of being re-derived per query.
-- Every branch of it needs a POSITIVE signal: a row with no signal for any of the five
-- kinds aborts this migration naming its id, rather than being given a default that
-- would then read as fact.

ALTER TABLE "agent_sessions" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "parent_session_id" uuid;--> statement-breakpoint

-- 1. The three writers that already declared a species on the SESSION row.
--    A fork and a rerun copy the SOURCE session's metadata wholesale
--    (`turns-routes.ts`, `...prevMeta` and `...session.metadata`), so an inherited
--    `type` here describes the session this one was cut from, not this one. Both are
--    interactive chats and branch 4 says so positively; trusting the copy would freeze
--    a pipeline or pm kind onto a chat, and no later branch can correct it because
--    they all require `kind IS NULL`.
UPDATE "agent_sessions" s
   SET "kind" = s."metadata"->>'type'
 WHERE s."kind" IS NULL
   AND s."metadata"->>'type' IN ('master','run_session','pipeline','pm')
   AND NOT (s."metadata" ? 'forkedFromTurnId')
   AND NOT (s."metadata" ? 'rerunOfSessionId');--> statement-breakpoint

-- 2. A session a job points at is that job's session, and `jobs.type` says which of
--    the two job-driven kinds it is. This is the same read `agent-session-link.ts`
--    does at insert time.
UPDATE "agent_sessions" s
   SET "kind" = CASE WHEN j."type" = 'pm' THEN 'pm' ELSE 'pipeline' END
  FROM "jobs" j
 WHERE j."agent_session_id" = s."id"
   AND s."kind" IS NULL;--> statement-breakpoint

-- 3. The RUN's own metadata carries the species for the two device-side writers, and
--    it is written by a different statement than the session's, so it survives rows
--    whose session metadata was later overwritten wholesale.
UPDATE "agent_sessions" s
   SET "kind" = r."metadata"->>'type'
  FROM "pipeline_runs" r
 WHERE r."id" = s."pipeline_run_id"
   AND s."kind" IS NULL
   AND r."metadata"->>'type' IN ('master','run_session');--> statement-breakpoint

-- 4. An `interactive` run is only ever opened by the chat path; nothing else asks for
--    that kind. This is a positive signal for `chat`, not a fallback.
UPDATE "agent_sessions" s
   SET "kind" = 'chat'
  FROM "pipeline_runs" r
 WHERE r."id" = s."pipeline_run_id"
   AND s."kind" IS NULL
   AND r."kind" = 'interactive';--> statement-breakpoint

-- 5. A `system` run carrying a `source` is a chat started by a schedule, an
--    escalation, the onboarding flow or the conversation agent — each of which stamps
--    that key and none of which is a master or a run session. The same for a session
--    the fork or rerun paths wrote, which name the row they were cut from.
UPDATE "agent_sessions" s
   SET "kind" = 'chat'
  FROM "pipeline_runs" r
 WHERE r."id" = s."pipeline_run_id"
   AND s."kind" IS NULL
   AND (
        r."metadata" ? 'source'
     OR s."metadata" ? 'parentSessionId'
     OR s."metadata" ? 'rerunOfSessionId'
     OR s."metadata" ? 'conversationAgent'
     OR s."metadata" ? 'escalation'
   );--> statement-breakpoint

-- 6. Anything still unclassified is a row this audit did not enumerate. Say so and
--    stop: the column is still nullable and nothing below has run, so the schema is
--    exactly as it was and the deploy fails closed.
DO $$
DECLARE unresolved_count bigint; sample text;
BEGIN
  SELECT count(*) INTO unresolved_count FROM "agent_sessions" WHERE "kind" IS NULL;
  IF unresolved_count > 0 THEN
    SELECT string_agg(x.id::text, ', ') INTO sample
      FROM (SELECT "id" FROM "agent_sessions" WHERE "kind" IS NULL ORDER BY "created_at" LIMIT 20) x;
    RAISE EXCEPTION
      'ISS-1136: % agent_sessions row(s) carry no signal for any of the five session kinds, so this migration cannot say what they are. First up to 20 by created_at: %. Classify them by hand, or widen the inference in 0293 with the signal these rows actually carry — do not give them a default, because a default here would read afterwards as a fact core established.',
      unresolved_count, sample;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "agent_sessions" ALTER COLUMN "kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_kind_check"
  CHECK ("kind" IN ('master','run_session','pipeline','pm','chat'));--> statement-breakpoint

-- The owner edge, backfilled from what core already held. Every source is held to the
-- same test its live writer is held to: the candidate must itself be a master of this
-- row's own project and device. A foreign key only proves a row exists, so a ledger
-- entry naming a real master on ANOTHER box would pass the constraint and still be the
-- wrong parent — the tree would then close an unrelated run when that master closed.
UPDATE "agent_sessions" s
   SET "parent_session_id" = m."id"
  FROM "jobs" j
  JOIN "agent_sessions" m ON m."id" = j."held_by"
 WHERE j."agent_session_id" = s."id"
   AND s."parent_session_id" IS NULL
   AND m."kind" = 'master'
   AND m."project_id" = s."project_id"
   AND (s."device_id" IS NULL OR m."device_id" = s."device_id");--> statement-breakpoint

UPDATE "agent_sessions" s
   SET "parent_session_id" = m."id"
  FROM "device_run_ledger" l
  JOIN "agent_sessions" m ON m."id" = l."master_session_id"
 WHERE l."session_id" = s."id"
   AND s."parent_session_id" IS NULL
   AND m."kind" = 'master'
   AND m."project_id" = s."project_id"
   AND m."device_id" = l."device_id"
   AND s."device_id" = l."device_id";--> statement-breakpoint

-- A fork or a rerun is a copy of a transcript and carries no device of its own, so the
-- test for it is the project alone.
UPDATE "agent_sessions" s
   SET "parent_session_id" = p."id"
  FROM "agent_sessions" p
 WHERE p."id"::text = COALESCE(s."metadata"->>'parentSessionId', s."metadata"->>'rerunOfSessionId')
   AND s."parent_session_id" IS NULL
   AND p."id" <> s."id"
   AND p."project_id" = s."project_id";--> statement-breakpoint

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_parent_session_id_fkey"
  FOREIGN KEY ("parent_session_id") REFERENCES "agent_sessions"("id") ON DELETE set null;--> statement-breakpoint

-- The box's claim gets the same constraint, which is the point: any path reporting a
-- parent core did not issue starts failing rather than being stored on trust. The
-- claims already stored that name nothing are cleared first, because the constraint
-- cannot be added over them and silently dropping the whole ledger row would cost an
-- operator the observation as well as the edge.
UPDATE "device_run_ledger" l
   SET "master_session_id" = NULL
 WHERE l."master_session_id" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "agent_sessions" s WHERE s."id" = l."master_session_id");--> statement-breakpoint

ALTER TABLE "device_run_ledger"
  ADD CONSTRAINT "device_run_ledger_master_session_id_agent_sessions_id_fk"
  FOREIGN KEY ("master_session_id") REFERENCES "agent_sessions"("id") ON DELETE set null;--> statement-breakpoint

-- One live master per (device, project) was an intention held by a select that ran
-- before an insert with nothing in between. A pair that already holds two is a pair
-- this migration cannot choose between, so it names them and stops rather than
-- deciding which master's children are corpses.
DO $$
DECLARE dupes text;
BEGIN
  SELECT string_agg(format('device %s / project %s (%s live masters)', d.device_id, d.project_id, d.n), '; ')
    INTO dupes
    FROM (
      SELECT "device_id", "project_id", count(*) AS n
        FROM "agent_sessions"
       WHERE "kind" = 'master'
         AND "device_id" IS NOT NULL
         AND "status" NOT IN ('completed','failed','completed_via_recovery','cancelled_stale','cancelled')
       GROUP BY "device_id", "project_id"
      HAVING count(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'ISS-1136: these device/project pairs already hold more than one live master session, so the unique index cannot be built and "the live master for this pair" is not a single answer: %. Close the masters that are not the one the box is actually attached to, then re-run this migration.',
      dupes;
  END IF;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX "agent_sessions_one_live_master_uq"
  ON "agent_sessions" ("device_id","project_id")
  WHERE kind = 'master' AND status NOT IN ('completed', 'failed', 'completed_via_recovery', 'cancelled_stale', 'cancelled');--> statement-breakpoint

CREATE INDEX "agent_sessions_kind_status_idx" ON "agent_sessions" ("kind","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_idx" ON "agent_sessions" ("parent_session_id");
