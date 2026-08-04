CREATE TABLE "integration_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_guides" ADD CONSTRAINT "integration_guides_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_guides" ADD CONSTRAINT "integration_guides_updated_by_users_id_fk"
	FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- One guide per integration per org: the row shadows the code-defined default
-- for that provider, so a second row for the same pair would make "which guide
-- does this org see" ambiguous.
CREATE UNIQUE INDEX "integration_guides_org_provider_uq" ON "integration_guides" USING btree ("org_id","provider");
