CREATE TABLE "requirement_baseline_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"workflow_id" uuid,
	"design_revision" integer,
	"provider_project_id" uuid,
	"contract_slug" text,
	"contract_version" text,
	CONSTRAINT "requirement_baseline_pins_arc_chk" CHECK ((num_nonnulls("requirement_baseline_pins"."workflow_id", "requirement_baseline_pins"."design_revision") = 2 AND num_nonnulls("requirement_baseline_pins"."provider_project_id", "requirement_baseline_pins"."contract_slug", "requirement_baseline_pins"."contract_version") = 0) OR (num_nonnulls("requirement_baseline_pins"."workflow_id", "requirement_baseline_pins"."design_revision") = 0 AND num_nonnulls("requirement_baseline_pins"."provider_project_id", "requirement_baseline_pins"."contract_slug", "requirement_baseline_pins"."contract_version") = 3))
);
--> statement-breakpoint
CREATE TABLE "requirement_baselines" (
	"requirement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"agreed_by" uuid NOT NULL,
	"agreed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "requirement_baselines_requirement_id_revision_pk" PRIMARY KEY("requirement_id","revision")
);
--> statement-breakpoint
CREATE TABLE "requirement_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"code" text NOT NULL,
	"body" text NOT NULL,
	"form" text DEFAULT 'statement' NOT NULL,
	"since_revision" integer NOT NULL,
	"retired_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_criteria_code_chk" CHECK ("requirement_criteria"."code" ~ '^BC-[1-9][0-9]*$'),
	CONSTRAINT "requirement_criteria_form_chk" CHECK ("requirement_criteria"."form" IN ('statement', 'scenario')),
	CONSTRAINT "requirement_criteria_body_chk" CHECK ("requirement_criteria"."body" ~ '[^[:space:]]'),
	CONSTRAINT "requirement_criteria_retired_chk" CHECK ("requirement_criteria"."retired_revision" IS NULL OR "requirement_criteria"."retired_revision" > "requirement_criteria"."since_revision")
);
--> statement-breakpoint
CREATE TABLE "requirement_revisions" (
	"requirement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"base_revision" integer,
	"spec" jsonb NOT NULL,
	"spec_version" integer DEFAULT 1 NOT NULL,
	"tldr" text,
	"change_summary" text,
	"reason" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposed_at" timestamp with time zone,
	"proposed_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"return_reason" text,
	CONSTRAINT "requirement_revisions_requirement_id_revision_pk" PRIMARY KEY("requirement_id","revision"),
	CONSTRAINT "requirement_revisions_state_chk" CHECK ("requirement_revisions"."state" IN ('draft', 'proposed', 'current', 'superseded')),
	CONSTRAINT "requirement_revisions_revision_chk" CHECK ("requirement_revisions"."revision" >= 1),
	CONSTRAINT "requirement_revisions_reason_chk" CHECK ("requirement_revisions"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "requirement_revisions_decided_chk" CHECK ("requirement_revisions"."state" NOT IN ('current', 'superseded') OR ("requirement_revisions"."decided_by" IS NOT NULL AND "requirement_revisions"."decided_at" IS NOT NULL)),
	CONSTRAINT "requirement_revisions_base_chk" CHECK ("requirement_revisions"."base_revision" IS NULL OR "requirement_revisions"."base_revision" < "requirement_revisions"."revision")
);
--> statement-breakpoint
CREATE TABLE "requirement_workflows" (
	"requirement_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_workflows_requirement_id_workflow_id_pk" PRIMARY KEY("requirement_id","workflow_id")
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"req_seq" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_revision" integer,
	"owner_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirements_status_chk" CHECK ("requirements"."status" IN ('draft', 'agreed', 'accepted', 'dropped')),
	CONSTRAINT "requirements_seq_chk" CHECK ("requirements"."req_seq" >= 1),
	CONSTRAINT "requirements_agreed_head_chk" CHECK ("requirements"."status" NOT IN ('agreed', 'accepted') OR "requirements"."current_revision" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "requirement_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "planned_revision" integer;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_baseline_fk" FOREIGN KEY ("requirement_id","revision") REFERENCES "public"."requirement_baselines"("requirement_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_design_fk" FOREIGN KEY ("workflow_id","design_revision") REFERENCES "public"."project_workflow_designs"("workflow_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_contract_fk" FOREIGN KEY ("provider_project_id","contract_slug","contract_version") REFERENCES "public"."contract_versions"("provider_project_id","contract_slug","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_agreed_by_users_id_fk" FOREIGN KEY ("agreed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_revision_fk" FOREIGN KEY ("requirement_id","revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_criteria" ADD CONSTRAINT "requirement_criteria_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_criteria" ADD CONSTRAINT "requirement_criteria_since_fk" FOREIGN KEY ("requirement_id","since_revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_workflows" ADD CONSTRAINT "requirement_workflows_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_workflows" ADD CONSTRAINT "requirement_workflows_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_workflows" ADD CONSTRAINT "requirement_workflows_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_head_fk" FOREIGN KEY ("id","current_revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_baseline_pins_baseline_idx" ON "requirement_baseline_pins" USING btree ("requirement_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_criteria_live_code_uq" ON "requirement_criteria" USING btree ("requirement_id","code") WHERE retired_revision IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_criteria_wording_uq" ON "requirement_criteria" USING btree ("requirement_id","code","since_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_revisions_one_current_uq" ON "requirement_revisions" USING btree ("requirement_id") WHERE state = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_revisions_one_open_uq" ON "requirement_revisions" USING btree ("requirement_id") WHERE state IN ('draft', 'proposed');--> statement-breakpoint
CREATE INDEX "requirement_workflows_workflow_idx" ON "requirement_workflows" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_project_seq_uq" ON "requirements" USING btree ("project_id","req_seq");--> statement-breakpoint
CREATE INDEX "requirements_project_status_idx" ON "requirements" USING btree ("project_id","status");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_planned_revision_fk" FOREIGN KEY ("requirement_id","planned_revision") REFERENCES "public"."requirement_revisions"("requirement_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_requirement_idx" ON "issues" USING btree ("requirement_id") WHERE requirement_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_planned_revision_chk" CHECK ("issues"."planned_revision" IS NULL OR "issues"."requirement_id" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION "requirement_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
      RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is evidence and is never deleted; only deleting its requirement removes it', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."requirement_id" <> OLD."requirement_id" OR NEW."revision" <> OLD."revision" THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % keeps its identity', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'draft' AND (
       NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."spec_version" IS DISTINCT FROM OLD."spec_version"
    OR NEW."tldr" IS DISTINCT FROM OLD."tldr" OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
    OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."base_revision" IS DISTINCT FROM OLD."base_revision"
    OR NEW."author_id" IS DISTINCT FROM OLD."author_id") THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is %, so its content is frozen; write a new revision', OLD."requirement_id", OLD."revision", OLD."state" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND (OLD."state", NEW."state") NOT IN (
       ('draft', 'proposed'), ('proposed', 'draft'), ('proposed', 'current'), ('current', 'superseded')) THEN
    RAISE EXCEPTION 'REVISION_STATE_TRANSITION: requirement % revision % cannot move % -> %; a revision moves draft, proposed, current, superseded', OLD."requirement_id", OLD."revision", OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "requirement_revisions_guard" BEFORE UPDATE OR DELETE ON "requirement_revisions" FOR EACH ROW EXECUTE FUNCTION "requirement_revision_guard"();
--> statement-breakpoint
CREATE FUNCTION "requirement_baseline_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'BASELINE_IMMUTABLE: a baseline of requirement % and its pins are insert-only; agreeing again writes a new one', OLD."requirement_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "requirement_baselines_guard" BEFORE UPDATE OR DELETE ON "requirement_baselines" FOR EACH ROW EXECUTE FUNCTION "requirement_baseline_guard"();
--> statement-breakpoint
CREATE TRIGGER "requirement_baseline_pins_guard" BEFORE UPDATE OR DELETE ON "requirement_baseline_pins" FOR EACH ROW EXECUTE FUNCTION "requirement_baseline_guard"();
--> statement-breakpoint
CREATE VIEW "requirement_delivery" AS
SELECT r."id" AS "requirement_id",
  CASE
    WHEN r."status" NOT IN ('agreed', 'accepted') THEN NULL
    WHEN count(i."id") FILTER (WHERE i."status" <> 'dropped') = 0 THEN 'agreed'
    WHEN count(i."id") FILTER (WHERE i."status" NOT IN ('dropped', 'closed')) = 0 THEN 'delivered'
    WHEN count(i."id") FILTER (WHERE i."status" NOT IN ('dropped', 'draft', 'open')) > 0 THEN 'in_delivery'
    ELSE 'agreed'
  END AS "phase",
  (count(i."id") FILTER (WHERE i."status" <> 'dropped'))::int AS "live_issues",
  (count(i."id") FILTER (WHERE i."status" NOT IN ('dropped', 'draft', 'open')))::int AS "started_issues",
  (count(i."id") FILTER (WHERE i."status" = 'closed'))::int AS "closed_issues"
FROM "requirements" r
LEFT JOIN "issues" i ON i."requirement_id" = r."id"
GROUP BY r."id", r."status";
