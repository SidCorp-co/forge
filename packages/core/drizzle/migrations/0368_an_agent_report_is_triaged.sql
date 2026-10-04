ALTER TABLE "agent_reports" DROP CONSTRAINT "agent_reports_promoted_reviewed_chk";--> statement-breakpoint
ALTER TABLE "agent_reports" DROP CONSTRAINT "agent_reports_linked_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "schedule_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "triage" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "triaged_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "triaged_agency" text;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "triage_reason" text;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "duplicate_of" uuid;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_triaged_by_users_id_fk" FOREIGN KEY ("triaged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_duplicate_of_agent_reports_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."agent_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$
DECLARE
  stray record;
  to_new integer;
  to_filed integer;
  to_dismissed integer;
  fire_linked integer;
  fire_unlinked jsonb;
  this_run jsonb;
BEGIN
  SELECT r."id", r."linked_issue_id", r."feedback_id" INTO stray FROM "agent_reports" r
  WHERE r."reviewed_at" IS NULL AND num_nonnulls(r."linked_issue_id", r."feedback_id") > 0
  ORDER BY r."created_at", r."id" LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AGENT_REPORT_TRIAGE_UNMAPPED: agent_reports row % is unreviewed but links issue % and feedback %; an unreviewed report becomes new, which has no target, and a filed one needs the time it was reviewed, so this migration writes nothing until that row is repaired', stray."id", coalesce(stray."linked_issue_id"::text, 'null'), coalesce(stray."feedback_id"::text, 'null') USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO to_new FROM "agent_reports" WHERE "reviewed_at" IS NULL;
  UPDATE "agent_reports" SET "triage" = 'filed', "triaged_at" = "reviewed_at"
  WHERE "reviewed_at" IS NOT NULL AND num_nonnulls("linked_issue_id", "feedback_id") = 1;
  GET DIAGNOSTICS to_filed = ROW_COUNT;
  UPDATE "agent_reports" SET "triage" = 'dismissed', "triaged_at" = "reviewed_at",
         "triage_reason" = 'reviewed before triage was recorded'
  WHERE "reviewed_at" IS NOT NULL AND num_nonnulls("linked_issue_id", "feedback_id") = 0;
  GET DIAGNOSTICS to_dismissed = ROW_COUNT;

  UPDATE "agent_reports" r SET "schedule_run_id" = f."id"
  FROM "agent_sessions" a JOIN "schedule_runs" f ON f."id"::text = a."metadata" ->> 'scheduleRunId'
  WHERE a."id" = r."session_id" AND r."schedule_run_id" IS NULL;
  GET DIAGNOSTICS fire_linked = ROW_COUNT;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reportId', r."id", 'sessionId', r."session_id",
           'scheduleRunId', a."metadata" ->> 'scheduleRunId',
           'scheduleId', a."metadata" ->> 'scheduleId') ORDER BY r."created_at", r."id"), '[]'::jsonb)
  INTO fire_unlinked
  FROM "agent_reports" r JOIN "agent_sessions" a ON a."id" = r."session_id"
  WHERE r."schedule_run_id" IS NULL AND a."metadata" ->> 'source' = 'schedule.run';
  IF jsonb_array_length(fire_unlinked) > 0 THEN
    RAISE NOTICE 'agent_reports backfill: % report(s) came from a schedule session whose fire is not recorded, so they stay unlinked: %', jsonb_array_length(fire_unlinked), fire_unlinked;
  END IF;

  this_run := jsonb_build_object(
    'new', to_new,
    'filed', to_filed,
    'dismissed', to_dismissed,
    'fireLinked', fire_linked,
    'fireUnlinked', jsonb_array_length(fire_unlinked),
    'unlinked', fire_unlinked,
    'at', now()
  );
  INSERT INTO "backfill_markers" ("key", "completed_at", "report")
  VALUES ('0368_agent_report_triage', now(), jsonb_build_object('runs', jsonb_build_array(this_run)))
  ON CONFLICT ("key") DO UPDATE SET
    "completed_at" = excluded."completed_at",
    "report" = jsonb_build_object('runs', coalesce("backfill_markers"."report" -> 'runs', '[]'::jsonb) || jsonb_build_array(this_run));
  RAISE NOTICE 'agent_reports backfill: % new, % filed, % dismissed as reviewed before triage was recorded; % linked to the fire that filed them, % from a schedule session left unlinked', to_new, to_filed, to_dismissed, fire_linked, jsonb_array_length(fire_unlinked);
END $$;--> statement-breakpoint
ALTER TABLE "agent_reports" DROP COLUMN "reviewed_at";--> statement-breakpoint
CREATE INDEX "agent_reports_project_triage_idx" ON "agent_reports" USING btree ("project_id","triage");--> statement-breakpoint
CREATE INDEX "agent_reports_schedule_run_idx" ON "agent_reports" USING btree ("schedule_run_id") WHERE schedule_run_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_triage_chk" CHECK ("agent_reports"."triage" IN ('new', 'filed', 'dismissed', 'duplicate') AND CASE "agent_reports"."triage"
        WHEN 'new' THEN num_nonnulls("agent_reports"."triaged_by", "agent_reports"."triaged_agency", "agent_reports"."triaged_at", "agent_reports"."triage_reason", "agent_reports"."duplicate_of", "agent_reports"."linked_issue_id", "agent_reports"."feedback_id") = 0
        WHEN 'filed' THEN "agent_reports"."triaged_at" IS NOT NULL AND num_nonnulls("agent_reports"."linked_issue_id", "agent_reports"."feedback_id") = 1 AND "agent_reports"."duplicate_of" IS NULL
        WHEN 'dismissed' THEN "agent_reports"."triaged_at" IS NOT NULL AND btrim(coalesce("agent_reports"."triage_reason", '')) <> '' AND num_nonnulls("agent_reports"."duplicate_of", "agent_reports"."linked_issue_id", "agent_reports"."feedback_id") = 0
        WHEN 'duplicate' THEN "agent_reports"."triaged_at" IS NOT NULL AND "agent_reports"."duplicate_of" IS NOT NULL AND "agent_reports"."duplicate_of" <> "agent_reports"."id" AND num_nonnulls("agent_reports"."linked_issue_id", "agent_reports"."feedback_id") = 0
        ELSE false END);--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_triaged_by_chk" CHECK (("agent_reports"."triaged_by" IS NULL) = ("agent_reports"."triaged_agency" IS NULL) AND ("agent_reports"."triaged_agency" IS NULL OR "agent_reports"."triaged_agency" IN ('human', 'agent')));
