-- ISS-574 — UX Completeness Contract foundation tables.
-- `ux_contract_rules` is the per-project rule source of truth; the compiler
-- turns active rules → projectFacts['ux-contract'] prose on every mutation.
-- `ux_findings` records per-issue per-run observations that cite a rule.
-- Hand-written + registered in _journal.json.
CREATE TABLE IF NOT EXISTS "ux_contract_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"group" text NOT NULL,
	"text" text NOT NULL,
	"severity" text DEFAULT 'must' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"evidence_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ux_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid,
	"stage" text NOT NULL,
	"rule_id" uuid,
	"kind" text NOT NULL,
	"detail" text NOT NULL,
	"severity" text DEFAULT 'must' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ux_contract_rules" ADD CONSTRAINT "ux_contract_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ux_findings" ADD CONSTRAINT "ux_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ux_findings" ADD CONSTRAINT "ux_findings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ux_findings" ADD CONSTRAINT "ux_findings_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ux_findings" ADD CONSTRAINT "ux_findings_rule_id_ux_contract_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."ux_contract_rules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ux_contract_rules_project_status_idx" ON "ux_contract_rules" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ux_contract_rules_project_group_idx" ON "ux_contract_rules" USING btree ("project_id","group");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ux_findings_project_issue_idx" ON "ux_findings" USING btree ("project_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ux_findings_rule_idx" ON "ux_findings" USING btree ("rule_id");
