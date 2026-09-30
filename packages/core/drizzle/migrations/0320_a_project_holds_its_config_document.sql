-- The project config document, its policy copy, its testing profiles and its secrets, each held
-- in core behind one API document (design D1-D3). A write carries the revision it was read at and
-- is refused STALE_BASE when that has moved; every accepted project-document write also inserts
-- one write-once row into project_config_revisions, which a trigger keeps from being updated.
-- Secret values are AES-256-GCM ciphertext from integrations/vault.ts and never leave over the API.
-- Every table is new and starts empty; rollback is dropping them.
CREATE TABLE "project_config_documents" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_config_documents_revision_chk" CHECK ("project_config_documents"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_config_revisions" (
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_config_revisions_project_id_revision_pk" PRIMARY KEY("project_id","revision"),
	CONSTRAINT "project_config_revisions_revision_chk" CHECK ("project_config_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_policies" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_policies_revision_chk" CHECK ("project_policies"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_secrets" (
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"name" text NOT NULL,
	"value_enc" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secrets_project_id_scope_name_pk" PRIMARY KEY("project_id","scope","name"),
	CONSTRAINT "project_secrets_scope_chk" CHECK ("project_secrets"."scope" ~ '^[a-z][a-z0-9-]{0,62}$'),
	CONSTRAINT "project_secrets_name_chk" CHECK ("project_secrets"."name" ~ '^[a-z][a-z0-9-]{0,62}$')
);
--> statement-breakpoint
CREATE TABLE "project_testing_profiles" (
	"project_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_testing_profiles_project_id_profile_id_pk" PRIMARY KEY("project_id","profile_id"),
	CONSTRAINT "project_testing_profiles_revision_chk" CHECK ("project_testing_profiles"."revision" >= 1),
	CONSTRAINT "project_testing_profiles_profile_id_chk" CHECK ("project_testing_profiles"."profile_id" ~ '^[a-z][a-z0-9-]{0,62}$')
);
--> statement-breakpoint
ALTER TABLE "project_config_documents" ADD CONSTRAINT "project_config_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_documents" ADD CONSTRAINT "project_config_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_revisions" ADD CONSTRAINT "project_config_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_config_revisions" ADD CONSTRAINT "project_config_revisions_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policies" ADD CONSTRAINT "project_policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policies" ADD CONSTRAINT "project_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_testing_profiles" ADD CONSTRAINT "project_testing_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_testing_profiles" ADD CONSTRAINT "project_testing_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_config_revisions_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project_config_revisions is write-once: revision % of project % cannot be updated', OLD.revision, OLD.project_id;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_config_revisions_write_once_trg BEFORE UPDATE ON "project_config_revisions" FOR EACH ROW EXECUTE FUNCTION project_config_revisions_write_once();
