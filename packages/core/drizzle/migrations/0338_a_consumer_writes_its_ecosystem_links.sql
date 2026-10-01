CREATE TABLE "ecosystem_builder_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"trigger_sha" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by_user" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystem_builder_runs_trigger_chk" CHECK ("ecosystem_builder_runs"."trigger" IN ('joined', 'push')),
	CONSTRAINT "ecosystem_builder_runs_sha_chk" CHECK ("ecosystem_builder_runs"."trigger_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "ecosystem_builder_runs_revision_chk" CHECK ("ecosystem_builder_runs"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ecosystem_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"consumer_project_id" uuid NOT NULL,
	"module_path" text NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"pinned_version" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by_user" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystem_links_not_self_chk" CHECK ("ecosystem_links"."consumer_project_id" <> "ecosystem_links"."provider_project_id"),
	CONSTRAINT "ecosystem_links_state_chk" CHECK ("ecosystem_links"."state" IN ('building', 'current', 'behind', 'breaking', 'unverified')),
	CONSTRAINT "ecosystem_links_revision_chk" CHECK ("ecosystem_links"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ADD CONSTRAINT "ecosystem_builder_runs_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ADD CONSTRAINT "ecosystem_builder_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ADD CONSTRAINT "ecosystem_builder_runs_written_by_user_users_id_fk" FOREIGN KEY ("written_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_consumer_project_id_projects_id_fk" FOREIGN KEY ("consumer_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_written_by_user_users_id_fk" FOREIGN KEY ("written_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_pinned_version_fk" FOREIGN KEY ("provider_project_id","contract_slug","pinned_version") REFERENCES "public"."contract_versions"("provider_project_id","contract_slug","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ecosystem_builder_runs_project_idx" ON "ecosystem_builder_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "ecosystem_builder_runs_ecosystem_id_idx" ON "ecosystem_builder_runs" USING btree ("ecosystem_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_links_identity_uq" ON "ecosystem_links" USING btree ("consumer_project_id","module_path","provider_project_id","contract_slug");--> statement-breakpoint
CREATE INDEX "ecosystem_links_ecosystem_id_idx" ON "ecosystem_links" USING btree ("ecosystem_id");--> statement-breakpoint
CREATE INDEX "ecosystem_links_provider_idx" ON "ecosystem_links" USING btree ("provider_project_id","contract_slug");