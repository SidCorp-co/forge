-- A share link holds one frozen answer behind a hashed token (REQ-32, the share minimum). `share_links`
-- keeps the scrubbed report document a reader opens at /s/<token>, the SHA-256 of the token (the token
-- itself is shown once and never stored), its audience, and an expiry at most 30 days after creation.
-- The snapshot is frozen: trigger `share_link_guard` refuses any change but a revocation, which is
-- never undone, and the view count. A brand-new table, so no existing row can fail its checks.
--
-- ROLLBACK: DROP TABLE share_links; DROP FUNCTION share_link_guard().
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"audience" text NOT NULL,
	"subject_kind" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "share_links_audience_chk" CHECK ("share_links"."audience" IN ('members', 'link')),
	CONSTRAINT "share_links_subject_kind_chk" CHECK ("share_links"."subject_kind" IN ('message', 'template-output', 'status-report')),
	CONSTRAINT "share_links_expiry_chk" CHECK ("share_links"."expires_at" > "share_links"."created_at" AND "share_links"."expires_at" <= "share_links"."created_at" + interval '30 days'),
	CONSTRAINT "share_links_snapshot_chk" CHECK (jsonb_typeof("share_links"."snapshot") = 'object'),
	CONSTRAINT "share_links_token_hash_chk" CHECK ("share_links"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_revoked_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "share_links_token_hash_uq" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_project_created_idx" ON "share_links" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "share_link_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."token_hash" IS DISTINCT FROM OLD."token_hash"
     OR NEW."audience" IS DISTINCT FROM OLD."audience"
     OR NEW."subject_kind" IS DISTINCT FROM OLD."subject_kind"
     OR NEW."snapshot" IS DISTINCT FROM OLD."snapshot"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
     OR (NEW."revoked_by" IS DISTINCT FROM OLD."revoked_by" AND NEW."revoked_by" IS NOT NULL AND OLD."revoked_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'SHARE_LINK_FROZEN: share link % is frozen; only a revocation, never undone, and its view count change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "share_links_guard" ON "share_links";--> statement-breakpoint
CREATE TRIGGER "share_links_guard" BEFORE UPDATE ON "share_links" FOR EACH ROW EXECUTE FUNCTION "share_link_guard"();
