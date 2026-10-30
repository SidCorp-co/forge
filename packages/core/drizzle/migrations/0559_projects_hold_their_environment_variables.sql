-- Environment variables (REQ-80): a project's variables by key and scope, the changes agents propose
-- for them, and the audit of every act on them. A variable's value is a `project_secrets` row under
-- the reserved scope `var`, so the values live in one store; this migration aborts naming any secret
-- already stored under that scope, which the new schema would read as a variable's value.
--
-- ROLLBACK: DROP TABLE "project_variable_events"; DROP TABLE "project_variable_proposals"; DROP TABLE "project_variables"; DELETE FROM "project_secrets" WHERE "scope" = 'var';

DO $$
DECLARE held record;
BEGIN
	SELECT "project_id", "name" INTO held FROM "project_secrets" WHERE "scope" = 'var' LIMIT 1;
	IF FOUND AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'project_variables') THEN
		RAISE EXCEPTION 'project_secrets holds secret://var/% on project %, and the scope var is now the store of environment variable values; rename that secret before this migration runs', held."name", held."project_id";
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"key" text NOT NULL,
	"environment" text,
	"type" text NOT NULL,
	"protected" boolean NOT NULL,
	"secret_scope" text DEFAULT 'var' NOT NULL,
	"secret_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_variables_value_fk" FOREIGN KEY ("project_id", "secret_scope", "secret_name") REFERENCES "project_secrets"("project_id", "scope", "name"),
	CONSTRAINT "project_variables_type_chk" CHECK ("type" IN ('plain', 'secret', 'file')),
	CONSTRAINT "project_variables_key_chk" CHECK ("key" ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
	CONSTRAINT "project_variables_secret_scope_chk" CHECK ("secret_scope" = 'var'),
	CONSTRAINT "project_variables_version_chk" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_variables_key_scope_uq" ON "project_variables" USING btree ("project_id", "key", coalesce("environment", ''));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_variable_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"act" text NOT NULL,
	"key" text NOT NULL,
	"environment" text,
	"type" text,
	"protected" boolean,
	"secret_name" text,
	"fingerprint" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reason" text NOT NULL,
	"proposed_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"decided_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "project_variable_proposals_act_chk" CHECK ("act" IN ('set', 'delete')),
	CONSTRAINT "project_variable_proposals_status_chk" CHECK ("status" IN ('proposed', 'approved', 'rejected')),
	CONSTRAINT "project_variable_proposals_decided_chk" CHECK (("status" = 'proposed') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_variable_proposals_project_idx" ON "project_variable_proposals" USING btree ("project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_variable_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"variable_id" uuid,
	"act" text NOT NULL,
	"key" text NOT NULL,
	"environment" text,
	"actor_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"actor_token_id" uuid,
	"agency" text,
	"old_fingerprint" text,
	"new_fingerprint" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_variable_events_act_chk" CHECK ("act" IN ('created', 'updated', 'deleted', 'revealed', 'proposed', 'approved', 'rejected', 'delivered')),
	CONSTRAINT "project_variable_events_agency_chk" CHECK ("agency" IS NULL OR "agency" IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_variable_events_project_idx" ON "project_variable_events" USING btree ("project_id", "at");
