-- Fast delivery (REQ-79): the impact a building agent rates its change at, the cleanup debt it
-- leaves, and what each cleanup run reported. Three new tables, written only by the `cleanup` module;
-- no existing row changes.
--
-- ROLLBACK: DROP TABLE "delivery_debts"; DROP TABLE "cleanup_reports"; DROP TABLE "change_impacts";

CREATE TABLE IF NOT EXISTS "change_impacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"type" text NOT NULL,
	"rating" text NOT NULL,
	"reason" text NOT NULL,
	"commit_sha" text,
	"rated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_impacts_type_chk" CHECK ("type" IN ('ui', 'api', 'logic', 'data', 'config', 'runner')),
	CONSTRAINT "change_impacts_rating_chk" CHECK ("rating" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_impacts_issue_idx" ON "change_impacts" USING btree ("issue_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cleanup_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"schedule_run_id" uuid REFERENCES "schedule_runs"("id") ON DELETE set null,
	"branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"result" text NOT NULL,
	"ci" text,
	"cleared" jsonb NOT NULL,
	"remains" jsonb NOT NULL,
	"covers" jsonb NOT NULL,
	"reported_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cleanup_reports_result_chk" CHECK ("result" IN ('green', 'red')),
	CONSTRAINT "cleanup_reports_covers_chk" CHECK (jsonb_typeof("covers") = 'array' AND ("result" = 'green' OR "covers" = '[]'::jsonb))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cleanup_reports_project_idx" ON "cleanup_reports" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
	"kind" text NOT NULL,
	"check_name" text,
	"location" text NOT NULL,
	"detail" text NOT NULL,
	"impact_type" text NOT NULL,
	"impact_rating" text NOT NULL,
	"impact_reason" text NOT NULL,
	"recorded_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_report_id" uuid REFERENCES "cleanup_reports"("id") ON DELETE set null,
	"cleared_how" text,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "delivery_debts_kind_chk" CHECK ("kind" IN ('red', 'debt', 'simplify')),
	CONSTRAINT "delivery_debts_impact_type_chk" CHECK ("impact_type" IN ('ui', 'api', 'logic', 'data', 'config', 'runner')),
	CONSTRAINT "delivery_debts_impact_rating_chk" CHECK ("impact_rating" IN ('low', 'medium', 'high')),
	CONSTRAINT "delivery_debts_red_check_chk" CHECK ("kind" <> 'red' OR "check_name" IS NOT NULL),
	CONSTRAINT "delivery_debts_red_not_high_chk" CHECK ("kind" <> 'red' OR "impact_rating" <> 'high'),
	CONSTRAINT "delivery_debts_cleared_chk" CHECK (("cleared_at" IS NULL) = ("cleared_how" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_debts_open_idx" ON "delivery_debts" USING btree ("project_id", "created_at") WHERE "cleared_at" IS NULL;
