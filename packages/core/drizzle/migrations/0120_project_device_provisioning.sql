-- Per-project device control + workspace provisioning.
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0087-0091, 0116).
--
-- 1. projects.repo_url — optional per-project git clone URL (SSH form). When set
--    with a project git credential, a freshly-assigned device auto-clones here.
-- 2. runners provision_* — per (device × project) workspace provisioning state,
--    rendered by web as a live stepper; `queued` is the offline hand-off.
-- 3. project_git_credentials — optional per-project ed25519 deploy key. Private
--    key is vault-encrypted (same <iv:12><tag:16><ct> as integration secrets).
-- All additive + idempotent.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_url" text;

ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "provision_status" text;
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "provision_detail" text;
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "provision_requested_at" timestamp with time zone;
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "provisioned_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "project_git_credentials" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" "bytea" NOT NULL,
	"fingerprint" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "project_git_credentials" ADD CONSTRAINT "project_git_credentials_project_id_projects_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "project_git_credentials" ADD CONSTRAINT "project_git_credentials_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
