ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "refusal" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "disposition" text;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "pipeline_run_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "schedule_run_id" uuid;--> statement-breakpoint
ALTER TABLE "backfill_markers" ADD COLUMN IF NOT EXISTS "report" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_pipeline_run_id_pipeline_runs_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_schedule_run_id_schedule_runs_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_trigger_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_status_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_reason_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_refusal_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_finished_chk";--> statement-breakpoint
DROP INDEX IF EXISTS "schedule_runs_session_uq";--> statement-breakpoint
DO $$
DECLARE
  stray record;
BEGIN
  SELECT r."id", r."trigger", r."status" INTO stray FROM "schedule_runs" r
  WHERE r."trigger" NOT IN ('manual', 'scheduled') OR r."status" NOT IN ('success', 'failed', 'running', 'skipped')
  ORDER BY r."created_at", r."id" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_RUN_VOCABULARY: schedule_runs row % has trigger % and status %; a fire is triggered manual | scheduled and is success | failed | running | skipped, so this migration writes nothing until that row is repaired', stray."id", stray."trigger", stray."status" USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."id", r."status", r."finished_at" INTO stray FROM "schedule_runs" r
  WHERE (r."status" = 'running') <> (r."finished_at" IS NULL)
  ORDER BY r."created_at", r."id" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_RUN_FINISH: schedule_runs row % is % with finished_at %; a running fire has no finished_at and a settled one has it, so this migration writes nothing until that row is repaired', stray."id", stray."status", coalesce(stray."finished_at"::text, 'null') USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE
  stray record;
  named integer := 0;
  rescoped integer := 0;
  n integer;
  root record;
  newest record;
  chain uuid[];
  fire uuid;
  fire_status text;
  written integer := 0;
  linked integer := 0;
  unlinked jsonb := '[]'::jsonb;
  this_run jsonb;
BEGIN
  UPDATE "schedule_runs" r SET "reason" = 'nothing-to-do'
  FROM "schedules" s
  WHERE s."id" = r."schedule_id" AND r."status" = 'skipped' AND r."reason" IS NULL
    AND (s."kind" = 'sentry_pull' OR (s."kind" = 'release_batch' AND r."output" = 'nothing is waiting at the release gate'));
  GET DIAGNOSTICS n = ROW_COUNT;
  named := named + n;
  UPDATE "schedule_runs" r SET "reason" = 'gate-refused', "refusal" = 'NO_RELEASE_GATE'
  FROM "schedules" s
  WHERE s."id" = r."schedule_id" AND r."status" = 'skipped' AND r."reason" IS NULL
    AND s."kind" = 'release_batch' AND r."output" = 'this project has no release gate';
  GET DIAGNOSTICS n = ROW_COUNT;
  named := named + n;
  UPDATE "schedule_runs" r SET "reason" = 'gate-refused'
  FROM "schedules" s
  WHERE s."id" = r."schedule_id" AND r."status" = 'skipped' AND r."reason" IS NULL
    AND s."kind" = 'release_batch' AND r."output" LIKE 'no cut this tick: %';
  GET DIAGNOSTICS n = ROW_COUNT;
  named := named + n;
  SELECT r."id", s."kind", r."output" INTO stray
  FROM "schedule_runs" r JOIN "schedules" s ON s."id" = r."schedule_id"
  WHERE (r."status" = 'skipped') <> (r."reason" IS NOT NULL)
  ORDER BY r."created_at", r."id" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SCHEDULE_RUN_SKIP_UNNAMED: schedule_runs row % (a % fire) reads output %, which names none of no-device | project-not-found | already-applied | nothing-to-do | gate-refused, so this migration writes nothing until that row is repaired', stray."id", stray."kind", coalesce(stray."output", 'null') USING ERRCODE = 'check_violation';
  END IF;
  UPDATE "schedule_runs" r SET "project_id" = s."project_id"
  FROM "schedules" s
  WHERE s."id" = r."schedule_id" AND r."project_id" <> s."project_id";
  GET DIAGNOSTICS rescoped = ROW_COUNT;

  FOR root IN
    SELECT a."id", a."metadata", a."created_at", a."started_at", a."dispatched_at",
           s."id" AS "schedule_uuid", s."project_id" AS "schedule_project_id"
    FROM "agent_sessions" a
    LEFT JOIN "schedules" s ON s."id"::text = a."metadata" ->> 'scheduleId'
    WHERE a."metadata" ->> 'source' = 'schedule.run'
      AND NOT (a."metadata" ? 'scheduleRunId')
      AND NOT (
        a."metadata" ? 'failover'
        AND EXISTS (
          SELECT 1 FROM "agent_sessions" p
          WHERE p."id" = a."parent_session_id" AND p."metadata" ->> 'source' = 'schedule.run'
        )
      )
    ORDER BY a."created_at", a."id"
  LOOP
    IF root."schedule_uuid" IS NULL THEN
      unlinked := unlinked || jsonb_build_array(jsonb_build_object(
        'sessionId', root."id", 'scheduleId', root."metadata" ->> 'scheduleId'));
      RAISE NOTICE 'schedule_runs backfill: session % names schedule %, which does not exist, so it stays unlinked', root."id", coalesce(root."metadata" ->> 'scheduleId', '(none)');
      CONTINUE;
    END IF;

    WITH RECURSIVE "walk" AS (
      SELECT root."id" AS "id", 0 AS "depth"
      UNION ALL
      SELECT c."id", w."depth" + 1
      FROM "agent_sessions" c JOIN "walk" w ON c."parent_session_id" = w."id"
      WHERE c."metadata" ->> 'source' = 'schedule.run' AND c."metadata" ? 'failover' AND w."depth" < 16
    )
    SELECT array_agg("id") INTO chain FROM "walk";

    SELECT a."id", a."status", a."pipeline_run_id", a."failure_reason", a."failure_detail",
           a."updated_at", pr."finished_at" AS "run_finished_at"
    INTO newest
    FROM "agent_sessions" a LEFT JOIN "pipeline_runs" pr ON pr."id" = a."pipeline_run_id"
    WHERE a."id" = ANY (chain)
    ORDER BY a."created_at" DESC, a."id" DESC LIMIT 1;

    fire_status := CASE
      WHEN newest."status" IN ('completed', 'completed_via_recovery') THEN 'success'
      WHEN newest."status" IN ('failed', 'cancelled', 'cancelled_stale') THEN 'failed'
      WHEN newest."status" IN ('idle', 'queued', 'running') THEN 'running'
    END;
    IF fire_status IS NULL THEN
      RAISE EXCEPTION 'SCHEDULE_RUN_SESSION_UNMAPPED: session % of schedule % is %, which maps to no fire status, so this migration writes nothing until that row is repaired', newest."id", root."schedule_uuid", newest."status" USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO "schedule_runs" (
      "schedule_id", "project_id", "trigger", "status", "refusal", "error",
      "session_id", "pipeline_run_id", "started_at", "finished_at", "created_at"
    ) VALUES (
      root."schedule_uuid",
      root."schedule_project_id",
      CASE WHEN root."metadata" ->> 'tick' = 'true' THEN 'scheduled' ELSE 'manual' END,
      fire_status,
      CASE WHEN fire_status = 'failed' AND newest."failure_reason" = 'session_authority_refused'
                AND split_part(newest."failure_detail", ':', 1) ~ '^[A-Z][A-Z0-9_]*$'
           THEN split_part(newest."failure_detail", ':', 1) END,
      CASE WHEN fire_status = 'failed'
           THEN coalesce(newest."failure_reason", 'session ' || newest."status") || coalesce(': ' || newest."failure_detail", '') END,
      newest."id",
      newest."pipeline_run_id",
      coalesce(root."started_at", root."dispatched_at", root."created_at"),
      CASE WHEN fire_status = 'running' THEN NULL
           ELSE greatest(coalesce(newest."run_finished_at", newest."updated_at"),
                         coalesce(root."started_at", root."dispatched_at", root."created_at")) END,
      root."created_at"
    ) RETURNING "id" INTO fire;

    UPDATE "agent_sessions" SET "metadata" = "metadata" || jsonb_build_object('scheduleRunId', fire)
    WHERE "id" = ANY (chain);
    written := written + 1;
    linked := linked + cardinality(chain);
  END LOOP;

  this_run := jsonb_build_object(
    'firesWritten', written,
    'sessionsLinked', linked,
    'sessionsUnlinked', jsonb_array_length(unlinked),
    'unlinked', unlinked,
    'skipReasonsNamed', named,
    'rescoped', rescoped,
    'at', now()
  );
  INSERT INTO "backfill_markers" ("key", "completed_at", "report")
  VALUES ('0367_schedule_runs_one_row_per_fire', now(), jsonb_build_object('runs', jsonb_build_array(this_run)))
  ON CONFLICT ("key") DO UPDATE SET
    "completed_at" = excluded."completed_at",
    "report" = jsonb_build_object('runs', coalesce("backfill_markers"."report" -> 'runs', '[]'::jsonb) || jsonb_build_array(this_run));
  RAISE NOTICE 'schedule_runs backfill: % fire(s) written over % session(s); % session(s) name a schedule that does not exist and stay unlinked', written, linked, jsonb_array_length(unlinked);
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_session_uq" ON "schedule_runs" USING btree ("session_id") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_schedule_run_idx" ON "notifications" USING btree ("schedule_run_id") WHERE schedule_run_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_trigger_chk" CHECK ("schedule_runs"."trigger" IN ('manual', 'scheduled'));--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_status_chk" CHECK ("schedule_runs"."status" IN ('success', 'failed', 'running', 'skipped'));--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_reason_chk" CHECK (("schedule_runs"."status" = 'skipped') = ("schedule_runs"."reason" IS NOT NULL) AND ("schedule_runs"."reason" IS NULL OR "schedule_runs"."reason" IN ('no-device', 'project-not-found', 'already-applied', 'nothing-to-do', 'gate-refused')));--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_refusal_chk" CHECK ("schedule_runs"."refusal" IS NULL OR ("schedule_runs"."status" IN ('failed', 'skipped') AND "schedule_runs"."refusal" ~ '^[A-Z][A-Z0-9_]*$'));--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_finished_chk" CHECK (("schedule_runs"."status" = 'running') = ("schedule_runs"."finished_at" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_session_stop_settles_its_fire() RETURNS trigger AS $$
DECLARE
  ended text;
  detail text;
  settled record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ended := 'failed';
    detail := 'session deleted';
  ELSE
    ended := CASE WHEN NEW.status IN ('completed', 'completed_via_recovery') THEN 'success' ELSE 'failed' END;
    detail := coalesce(NEW.failure_reason, 'session ' || NEW.status) || coalesce(': ' || NEW.failure_detail, '');
  END IF;
  UPDATE schedule_runs
     SET status = ended,
         finished_at = now(),
         error = CASE WHEN ended = 'failed' THEN detail END,
         refusal = CASE WHEN ended = 'failed' AND TG_OP <> 'DELETE'
                         AND NEW.failure_reason = 'session_authority_refused'
                         AND split_part(NEW.failure_detail, ':', 1) ~ '^[A-Z][A-Z0-9_]*$'
                        THEN split_part(NEW.failure_detail, ':', 1) END
   WHERE session_id = OLD.id
     AND status = 'running'
  RETURNING id, schedule_id INTO settled;
  IF FOUND THEN
    UPDATE schedules s
       SET last_status = ended
     WHERE s.id = settled.schedule_id
       AND NOT EXISTS (
         SELECT 1 FROM schedule_runs newer, schedule_runs this_fire
          WHERE this_fire.id = settled.id
            AND newer.schedule_id = this_fire.schedule_id
            AND newer.created_at > this_fire.created_at
       );
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_stop_settles_its_fire ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_stop_settles_its_fire
  AFTER UPDATE OF status ON agent_sessions
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('idle', 'queued', 'running'))
  EXECUTE FUNCTION forge_session_stop_settles_its_fire();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_delete_settles_its_fire ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_delete_settles_its_fire
  BEFORE DELETE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION forge_session_stop_settles_its_fire();
