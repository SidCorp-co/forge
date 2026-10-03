CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"fb_seq" integer NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"where_seen" text,
	"requirement_id" uuid,
	"issue_id" uuid,
	"release_run_id" uuid,
	"workflow_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"route" text,
	"routed_issue_id" uuid,
	"routed_requirement_id" uuid,
	"routed_suggestion_id" uuid,
	"duplicate_of" uuid,
	"answer" text,
	"reported_by" uuid NOT NULL,
	"reporter_agency" text NOT NULL,
	"scrubbed" boolean DEFAULT false NOT NULL,
	"redactions" integer DEFAULT 0 NOT NULL,
	"redacted_at" timestamp with time zone,
	"redacted_by" uuid,
	"dedup_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_arc_chk" CHECK (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id") = 1 OR (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id") = 0 AND "feedback"."where_seen" IS NOT NULL)),
	CONSTRAINT "feedback_kind_chk" CHECK ("feedback"."kind" IN ('bug', 'change_request', 'question', 'idea', 'contract_change')),
	CONSTRAINT "feedback_severity_chk" CHECK ("feedback"."severity" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "feedback_status_chk" CHECK ("feedback"."status" IN ('new', 'triaged', 'reopened', 'verified', 'declined')),
	CONSTRAINT "feedback_route_chk" CHECK (("feedback"."route" IS NULL AND num_nonnulls("feedback"."routed_issue_id", "feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'issue' AND "feedback"."routed_issue_id" IS NOT NULL AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'revision' AND "feedback"."routed_suggestion_id" IS NOT NULL AND num_nonnulls("feedback"."routed_issue_id", "feedback"."routed_requirement_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'new_requirement' AND "feedback"."routed_requirement_id" IS NOT NULL AND num_nonnulls("feedback"."routed_issue_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'answer' AND "feedback"."answer" ~ '[^[:space:]]' AND num_nonnulls("feedback"."routed_issue_id", "feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of") = 0)
        OR ("feedback"."route" = 'duplicate' AND "feedback"."duplicate_of" IS NOT NULL AND num_nonnulls("feedback"."routed_issue_id", "feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."answer") = 0)),
	CONSTRAINT "feedback_status_route_chk" CHECK (("feedback"."status" <> 'triaged' OR "feedback"."route" IS NOT NULL) AND ("feedback"."status" <> 'new' OR "feedback"."route" IS NULL)),
	CONSTRAINT "feedback_duplicate_self_chk" CHECK ("feedback"."duplicate_of" IS NULL OR "feedback"."duplicate_of" <> "feedback"."id"),
	CONSTRAINT "feedback_redacted_chk" CHECK ("feedback"."redacted_at" IS NULL OR ("feedback"."body" IS NULL AND "feedback"."redacted_by" IS NOT NULL)),
	CONSTRAINT "feedback_reporter_agency_chk" CHECK ("feedback"."reporter_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "feedback_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"flagged" boolean NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"route" text,
	"carrier" text,
	"reason" text,
	"decided_by" uuid NOT NULL,
	"decided_agency" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_suggestion_id" uuid,
	CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'redacted')),
	CONSTRAINT "feedback_decisions_route_chk" CHECK (("feedback_decisions"."decision" = 'triaged') = ("feedback_decisions"."route" IS NOT NULL)),
	CONSTRAINT "feedback_decisions_reason_chk" CHECK ("feedback_decisions"."decision" NOT IN ('declined', 'reopened') OR "feedback_decisions"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "feedback_decisions_agency_chk" CHECK ("feedback_decisions"."decided_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "item_embeddings" DROP CONSTRAINT "item_embeddings_arc_chk";--> statement-breakpoint
ALTER TABLE "item_embeddings" DROP CONSTRAINT "item_embeddings_status_chk";--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_arc_chk";--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_kind_chk";--> statement-breakpoint
DROP INDEX "suggestions_open_twin_uq";--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "item_embeddings" drop column "item_type";--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD COLUMN "item_type" text GENERATED ALWAYS AS (CASE WHEN "item_embeddings"."requirement_id" IS NOT NULL THEN 'requirement' WHEN "item_embeddings"."feedback_id" IS NOT NULL THEN 'feedback' END) STORED;--> statement-breakpoint
ALTER TABLE "item_embeddings" drop column "item_id";--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD COLUMN "item_id" uuid GENERATED ALWAYS AS (coalesce("item_embeddings"."requirement_id", "item_embeddings"."feedback_id")) STORED;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_release_run_id_pipeline_runs_id_fk" FOREIGN KEY ("release_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_routed_issue_id_issues_id_fk" FOREIGN KEY ("routed_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_routed_requirement_id_requirements_id_fk" FOREIGN KEY ("routed_requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_routed_suggestion_id_suggestions_id_fk" FOREIGN KEY ("routed_suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_duplicate_of_feedback_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."feedback"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_redacted_by_users_id_fk" FOREIGN KEY ("redacted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_from_suggestion_id_suggestions_id_fk" FOREIGN KEY ("from_suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_project_seq_uq" ON "feedback" USING btree ("project_id","fb_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_project_dedup_uq" ON "feedback" USING btree ("project_id","dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_project_status_idx" ON "feedback" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "feedback_routed_issue_idx" ON "feedback" USING btree ("routed_issue_id") WHERE routed_issue_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_duplicate_of_idx" ON "feedback" USING btree ("duplicate_of") WHERE duplicate_of IS NOT NULL;--> statement-breakpoint
CREATE INDEX "feedback_attachments_feedback_idx" ON "feedback_attachments" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "feedback_decisions_feedback_idx" ON "feedback_decisions" USING btree ("feedback_id","decided_at");--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestions_feedback_idx" ON "suggestions" USING btree ("feedback_id","status") WHERE feedback_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_questions_feedback_open_uq" ON "agent_questions" USING btree ("feedback_id") WHERE "agent_questions"."status" = 'open' and "agent_questions"."feedback_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_open_twin_uq" ON "suggestions" USING btree ("kind",coalesce("requirement_id", "issue_id", "feedback_id"),"fingerprint") WHERE status = 'proposed';--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_arc_chk" CHECK (num_nonnulls("item_embeddings"."requirement_id", "item_embeddings"."feedback_id") = 1);--> statement-breakpoint
ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_status_chk" CHECK ("item_embeddings"."status" IN ('embedded', 'provider_not_configured', 'failed', 'withheld_by_policy'));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_arc_chk" CHECK (num_nonnulls("suggestions"."requirement_id", "suggestions"."issue_id", "suggestions"."feedback_id") = 1);--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_kind_chk" CHECK ("suggestions"."kind" IN ('requirement_draft', 'revision_diff', 'readiness', 'breakdown', 'triage', 'duplicate', 'feedback_triage'));--> statement-breakpoint
CREATE UNIQUE INDEX "item_embeddings_item_uq" ON "item_embeddings" USING btree ("item_type","item_id");--> statement-breakpoint
CREATE INDEX "item_embeddings_project_idx" ON "item_embeddings" USING btree ("project_id","item_type");--> statement-breakpoint
CREATE FUNCTION "feedback_keyed_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id") THEN
    RAISE EXCEPTION 'FEEDBACK_KEYED: FB-% of project % is keyed and never deleted; decline it, mark it a duplicate, or redact its reporter data', OLD."fb_seq", OLD."project_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER "feedback_keyed_guard" BEFORE DELETE ON "feedback" FOR EACH ROW EXECUTE FUNCTION "feedback_keyed_guard"();
--> statement-breakpoint
CREATE FUNCTION "feedback_duplicate_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  root_project uuid;
  root_of uuid;
BEGIN
  IF NEW."duplicate_of" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "project_id", "duplicate_of" INTO root_project, root_of FROM "feedback" WHERE "id" = NEW."duplicate_of";
  IF root_project IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'FEEDBACK_DUPLICATE_CHAIN: the root % is not an item of project %', NEW."duplicate_of", NEW."project_id" USING ERRCODE = 'check_violation';
  END IF;
  IF root_of IS NOT NULL THEN
    RAISE EXCEPTION 'FEEDBACK_DUPLICATE_CHAIN: % is itself a duplicate; point at its root %', NEW."duplicate_of", root_of USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "feedback" WHERE "duplicate_of" = NEW."id") THEN
    RAISE EXCEPTION 'FEEDBACK_DUPLICATE_CHAIN: % is the root of other items, so it cannot become a duplicate', NEW."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "feedback_duplicate_guard" BEFORE INSERT OR UPDATE OF "duplicate_of" ON "feedback" FOR EACH ROW EXECUTE FUNCTION "feedback_duplicate_guard"();
--> statement-breakpoint
CREATE FUNCTION "feedback_decision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'FEEDBACK_DECISION_IMMUTABLE: a decision on feedback % is insert-only; a new decision writes a new row', OLD."feedback_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "feedback_decisions_guard" BEFORE UPDATE OR DELETE ON "feedback_decisions" FOR EACH ROW EXECUTE FUNCTION "feedback_decision_guard"();
