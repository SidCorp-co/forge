CREATE TABLE "feedback_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	"route" text NOT NULL,
	"owner" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_agency" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"routed_at" timestamp with time zone,
	"routed_by" uuid,
	CONSTRAINT "feedback_cases_route_chk" CHECK ("feedback_cases"."route" IN ('issue', 'revision', 'new_requirement', 'answer', 'duplicate', 'decline')),
	CONSTRAINT "feedback_cases_owner_chk" CHECK ("feedback_cases"."owner" IN ('ba', 'master')),
	CONSTRAINT "feedback_cases_owner_route_chk" CHECK (("feedback_cases"."route" = 'issue') = ("feedback_cases"."owner" = 'master')),
	CONSTRAINT "feedback_cases_opened_agency_chk" CHECK ("feedback_cases"."opened_agency" IN ('human', 'agent')),
	CONSTRAINT "feedback_cases_routed_chk" CHECK (("feedback_cases"."routed_at" IS NULL) = ("feedback_cases"."routed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_status_route_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_decision_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_route_chk";--> statement-breakpoint
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cases" ADD CONSTRAINT "feedback_cases_routed_by_users_id_fk" FOREIGN KEY ("routed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_cases_feedback_uq" ON "feedback_cases" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "feedback_cases_project_open_idx" ON "feedback_cases" USING btree ("project_id","due_at") WHERE routed_at IS NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_status_route_chk" CHECK ("feedback"."status" <> 'new' OR "feedback"."route" IS NULL);--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'redacted', 'promoted', 'routed'));--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_route_chk" CHECK (("feedback_decisions"."decision" IN ('triaged', 'routed')) = ("feedback_decisions"."route" IS NOT NULL));--> statement-breakpoint
DO $$
DECLARE orphan text;
BEGIN
  SELECT 'FB-' || f.fb_seq || ' of project ' || f.project_id INTO orphan
    FROM feedback f
   WHERE (f.status = 'declined' OR f.route IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM feedback_decisions x
        WHERE x.feedback_id = f.id AND x.decision IN ('triaged', 'declined'))
   LIMIT 1;
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'feedback_cases backfill: % holds a route or a decline but no triage or decline decision to open its case from', orphan;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "feedback_cases" ("project_id", "feedback_id", "route", "owner", "opened_by", "opened_agency", "opened_at", "due_at", "routed_at", "routed_by")
SELECT f.project_id, f.id,
       CASE WHEN f.status = 'declined' THEN 'decline' ELSE f.route END,
       CASE WHEN f.status <> 'declined' AND f.route = 'issue' THEN 'master' ELSE 'ba' END,
       d.decided_by, d.decided_agency, d.decided_at, d.decided_at, d.decided_at, d.decided_by
  FROM feedback f
  JOIN LATERAL (
    SELECT x.decided_by, x.decided_agency, x.decided_at FROM feedback_decisions x
     WHERE x.feedback_id = f.id AND x.decision IN ('triaged', 'declined')
     ORDER BY x.decided_at DESC LIMIT 1) d ON true
 WHERE f.status = 'declined' OR f.route IS NOT NULL;
