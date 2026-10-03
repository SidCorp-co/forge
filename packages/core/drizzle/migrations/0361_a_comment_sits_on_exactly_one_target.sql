CREATE TABLE "comment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"decision" jsonb,
	"actor_id" uuid NOT NULL,
	"actor_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_events_kind_chk" CHECK ("comment_events"."kind" IN ('posted', 'edited')),
	CONSTRAINT "comment_events_agency_chk" CHECK ("comment_events"."actor_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "decision" jsonb;--> statement-breakpoint
ALTER TABLE "comment_events" ADD CONSTRAINT "comment_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_events" ADD CONSTRAINT "comment_events_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_events" ADD CONSTRAINT "comment_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_events_comment_idx" ON "comment_events" USING btree ("comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_events_project_idx" ON "comment_events" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_requirement_created_idx" ON "comments" USING btree ("requirement_id","created_at","id") WHERE requirement_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "comments_workflow_created_idx" ON "comments" USING btree ("workflow_id","created_at","id") WHERE workflow_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "comments_feedback_created_idx" ON "comments" USING btree ("feedback_id","created_at","id") WHERE feedback_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "comments_decision_created_idx" ON "comments" USING btree ("created_at","id") WHERE intent = 'decision';--> statement-breakpoint
DO $$
DECLARE
  stray record;
BEGIN
  SELECT "id", num_nonnulls("issue_id", "requirement_id", "workflow_id", "feedback_id") AS "targets" INTO stray
    FROM "comments"
    WHERE num_nonnulls("issue_id", "requirement_id", "workflow_id", "feedback_id") <> 1
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'COMMENT_SCOPE_INVALID: comment % names % targets; every comment sits on exactly one of issue | requirement | workflow | feedback, so this migration writes nothing until that row is repaired', stray."id", stray."targets" USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_scope_chk" CHECK (num_nonnulls("comments"."issue_id", "comments"."requirement_id", "comments"."workflow_id", "comments"."feedback_id") = 1);--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_decision_intent_chk" CHECK ("comments"."decision" IS NULL OR "comments"."intent" = 'decision');--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_decision_fields_chk" CHECK ("comments"."intent" <> 'decision' OR "comments"."issue_id" IS NOT NULL OR COALESCE(jsonb_typeof("comments"."decision" -> 'decision') = 'string' AND jsonb_typeof("comments"."decision" -> 'reason') = 'string' AND ("comments"."decision" ->> 'decision') ~ '[^[:space:]]' AND ("comments"."decision" ->> 'reason') ~ '[^[:space:]]', false));--> statement-breakpoint
CREATE FUNCTION "comment_event_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "comments" WHERE "id" = OLD."comment_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'COMMENT_EVENT_IMMUTABLE: an event of comment % is insert-only; an edit writes a new row', OLD."comment_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "comment_events_guard" BEFORE UPDATE OR DELETE ON "comment_events" FOR EACH ROW EXECUTE FUNCTION "comment_event_guard"();
