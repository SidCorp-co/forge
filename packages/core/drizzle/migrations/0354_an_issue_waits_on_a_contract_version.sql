CREATE TABLE "contract_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"channel_document_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_requests_not_self_chk" CHECK ("contract_requests"."project_id" <> "contract_requests"."provider_project_id"),
	CONSTRAINT "contract_requests_agency_chk" CHECK ("contract_requests"."requested_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "issue_contract_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"min_version" text NOT NULL,
	"reason" text,
	"contract_request_id" uuid,
	"created_by" uuid NOT NULL,
	"created_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_version" text,
	"settled_at" timestamp with time zone,
	"retracted_by" uuid,
	"retracted_agency" text,
	"retracted_at" timestamp with time zone,
	"retract_reason" text,
	CONSTRAINT "issue_contract_waits_not_self_chk" CHECK ("issue_contract_waits"."project_id" <> "issue_contract_waits"."provider_project_id"),
	CONSTRAINT "issue_contract_waits_version_chk" CHECK (length("issue_contract_waits"."min_version") BETWEEN 1 AND 40),
	CONSTRAINT "issue_contract_waits_reason_chk" CHECK ("issue_contract_waits"."reason" IS NULL OR length("issue_contract_waits"."reason") BETWEEN 1 AND 1000),
	CONSTRAINT "issue_contract_waits_settled_chk" CHECK (("issue_contract_waits"."settled_version" IS NULL) = ("issue_contract_waits"."settled_at" IS NULL)),
	CONSTRAINT "issue_contract_waits_retracted_chk" CHECK (("issue_contract_waits"."retracted_at" IS NULL) = ("issue_contract_waits"."retracted_by" IS NULL) AND ("issue_contract_waits"."retracted_at" IS NULL) = ("issue_contract_waits"."retracted_agency" IS NULL) AND ("issue_contract_waits"."retracted_at" IS NULL) = ("issue_contract_waits"."retract_reason" IS NULL)),
	CONSTRAINT "issue_contract_waits_agency_chk" CHECK ("issue_contract_waits"."created_agency" IN ('human', 'agent') AND ("issue_contract_waits"."retracted_agency" IS NULL OR "issue_contract_waits"."retracted_agency" IN ('human', 'agent')))
);
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_arc_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "contract_provider_project_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "contract_slug" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "contract_version" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_channel_document_id_channel_documents_id_fk" FOREIGN KEY ("channel_document_id") REFERENCES "public"."channel_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD CONSTRAINT "contract_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_contract_request_id_contract_requests_id_fk" FOREIGN KEY ("contract_request_id") REFERENCES "public"."contract_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_retracted_by_users_id_fk" FOREIGN KEY ("retracted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD CONSTRAINT "issue_contract_waits_settled_version_fk" FOREIGN KEY ("provider_project_id","contract_slug","settled_version") REFERENCES "public"."contract_versions"("provider_project_id","contract_slug","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_requests_document_uq" ON "contract_requests" USING btree ("channel_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_requests_requirement_uq" ON "contract_requests" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "contract_requests_project_idx" ON "contract_requests" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "contract_requests_provider_idx" ON "contract_requests" USING btree ("provider_project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_contract_waits_live_uq" ON "issue_contract_waits" USING btree ("issue_id","provider_project_id","contract_slug") WHERE retracted_at IS NULL;--> statement-breakpoint
CREATE INDEX "issue_contract_waits_project_issue_idx" ON "issue_contract_waits" USING btree ("project_id","issue_id");--> statement-breakpoint
CREATE INDEX "issue_contract_waits_open_idx" ON "issue_contract_waits" USING btree ("provider_project_id","contract_slug") WHERE retracted_at IS NULL AND settled_at IS NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_contract_provider_project_id_projects_id_fk" FOREIGN KEY ("contract_provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_contract_version_fk" FOREIGN KEY ("contract_provider_project_id","contract_slug","contract_version") REFERENCES "public"."contract_versions"("provider_project_id","contract_slug","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_contract_target_chk" CHECK (num_nonnulls("feedback"."contract_provider_project_id", "feedback"."contract_slug", "feedback"."contract_version") IN (0, 3));--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_due_chk" CHECK ("feedback"."due_at" IS NULL OR "feedback"."contract_version" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_arc_chk" CHECK (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version") = 1 OR (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version") = 0 AND "feedback"."where_seen" IS NOT NULL));--> statement-breakpoint
CREATE FUNCTION "contract_request_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id")
    OR NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."provider_project_id")) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CONTRACT_REQUEST_IMMUTABLE: contract request % pairs a published change request with the requirement it landed as, and is insert-only', OLD."id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "contract_requests_guard" BEFORE UPDATE OR DELETE ON "contract_requests" FOR EACH ROW EXECUTE FUNCTION "contract_request_guard"();
--> statement-breakpoint
CREATE FUNCTION "issue_contract_wait_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "issues" WHERE "id" = OLD."issue_id")
       AND EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."provider_project_id") THEN
      RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % is retracted, never deleted; only deleting its issue or a project removes it', OLD."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."issue_id" <> OLD."issue_id" OR NEW."project_id" <> OLD."project_id"
    OR NEW."provider_project_id" <> OLD."provider_project_id" OR NEW."contract_slug" <> OLD."contract_slug"
    OR NEW."min_version" <> OLD."min_version" OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."contract_request_id" IS DISTINCT FROM OLD."contract_request_id"
    OR NEW."created_by" <> OLD."created_by" OR NEW."created_agency" <> OLD."created_agency"
    OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % keeps what it waits on; retract it and add another', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."settled_at" IS NOT NULL AND (NEW."settled_at" IS DISTINCT FROM OLD."settled_at" OR NEW."settled_version" IS DISTINCT FROM OLD."settled_version") THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % settled on %, and an approved version is never unapproved', OLD."id", OLD."settled_version" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."retracted_at" IS NOT NULL AND (NEW."retracted_at" IS DISTINCT FROM OLD."retracted_at" OR NEW."retract_reason" IS DISTINCT FROM OLD."retract_reason") THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % is retracted; add a new wait instead', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "issue_contract_waits_guard" BEFORE UPDATE OR DELETE ON "issue_contract_waits" FOR EACH ROW EXECUTE FUNCTION "issue_contract_wait_guard"();
