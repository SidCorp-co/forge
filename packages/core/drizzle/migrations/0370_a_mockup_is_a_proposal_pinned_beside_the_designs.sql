CREATE TABLE "mockups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"mockup_seq" integer NOT NULL,
	"requirement_id" uuid,
	"revision" integer,
	"feedback_id" uuid,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"caption" text,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposed_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "mockups_target_chk" CHECK (num_nonnulls("mockups"."requirement_id", "mockups"."feedback_id", "mockups"."issue_id") = 1 AND ("mockups"."requirement_id" IS NULL) = ("mockups"."revision" IS NULL)),
	CONSTRAINT "mockups_kind_chk" CHECK ("mockups"."kind" IN ('wireframe', 'sketch', 'image', 'html', 'api_example')),
	CONSTRAINT "mockups_status_chk" CHECK ("mockups"."status" IN ('proposed', 'accepted', 'returned', 'withdrawn')),
	CONSTRAINT "mockups_agency_chk" CHECK ("mockups"."proposed_agency" IN ('human', 'agent')),
	CONSTRAINT "mockups_size_chk" CHECK ("mockups"."size" > 0),
	CONSTRAINT "mockups_seq_chk" CHECK ("mockups"."mockup_seq" >= 1),
	CONSTRAINT "mockups_decided_chk" CHECK ("mockups"."status" = 'proposed' OR ("mockups"."decided_by" IS NOT NULL AND "mockups"."decided_at" IS NOT NULL)),
	CONSTRAINT "mockups_returned_reason_chk" CHECK ("mockups"."status" <> 'returned' OR "mockups"."reason" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" DROP CONSTRAINT "requirement_baseline_pins_arc_chk";--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD COLUMN "mockup_id" uuid;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockups" ADD CONSTRAINT "mockups_revision_fk" FOREIGN KEY ("requirement_id","revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mockups_project_seq_uq" ON "mockups" USING btree ("project_id","mockup_seq");--> statement-breakpoint
CREATE INDEX "mockups_requirement_idx" ON "mockups" USING btree ("project_id","requirement_id") WHERE requirement_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mockups_feedback_idx" ON "mockups" USING btree ("project_id","feedback_id") WHERE feedback_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mockups_issue_idx" ON "mockups" USING btree ("project_id","issue_id") WHERE issue_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_mockup_id_mockups_id_fk" FOREIGN KEY ("mockup_id") REFERENCES "public"."mockups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_arc_chk" CHECK ((num_nonnulls("requirement_baseline_pins"."workflow_id", "requirement_baseline_pins"."design_revision") = 2 AND num_nonnulls("requirement_baseline_pins"."provider_project_id", "requirement_baseline_pins"."contract_slug", "requirement_baseline_pins"."contract_version", "requirement_baseline_pins"."mockup_id") = 0) OR (num_nonnulls("requirement_baseline_pins"."workflow_id", "requirement_baseline_pins"."design_revision", "requirement_baseline_pins"."mockup_id") = 0 AND num_nonnulls("requirement_baseline_pins"."provider_project_id", "requirement_baseline_pins"."contract_slug", "requirement_baseline_pins"."contract_version") = 3) OR (num_nonnulls("requirement_baseline_pins"."workflow_id", "requirement_baseline_pins"."design_revision", "requirement_baseline_pins"."provider_project_id", "requirement_baseline_pins"."contract_slug", "requirement_baseline_pins"."contract_version") = 0 AND "requirement_baseline_pins"."mockup_id" IS NOT NULL));--> statement-breakpoint
CREATE FUNCTION "mockup_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."feedback_id" IS NOT NULL AND EXISTS (
         SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id" AND "redacted_at" IS NOT NULL) THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id")
       AND (EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id")
         OR EXISTS (SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id")
         OR EXISTS (SELECT 1 FROM "issues" WHERE "id" = OLD."issue_id")) THEN
      RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % is evidence and is never deleted; only deleting its target, or a reporter-data deletion of its feedback item, removes it', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."project_id" <> OLD."project_id" OR NEW."mockup_seq" <> OLD."mockup_seq"
     OR NEW."requirement_id" IS DISTINCT FROM OLD."requirement_id" OR NEW."revision" IS DISTINCT FROM OLD."revision"
     OR NEW."feedback_id" IS DISTINCT FROM OLD."feedback_id" OR NEW."issue_id" IS DISTINCT FROM OLD."issue_id"
     OR NEW."kind" <> OLD."kind" OR NEW."name" <> OLD."name" OR NEW."mime" <> OLD."mime" OR NEW."size" <> OLD."size"
     OR NEW."caption" IS DISTINCT FROM OLD."caption" OR NEW."storage_path" <> OLD."storage_path"
     OR NEW."proposed_by" <> OLD."proposed_by" OR NEW."proposed_agency" <> OLD."proposed_agency" THEN
    RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % keeps what it holds and what it is about; propose a new one instead', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'proposed' THEN
    RAISE EXCEPTION 'MOCKUP_IMMUTABLE: mockup % is %, and a decided mockup stays decided', OLD."id", OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "mockups_guard" BEFORE UPDATE OR DELETE ON "mockups" FOR EACH ROW EXECUTE FUNCTION "mockup_guard"();
