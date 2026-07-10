-- ISS-628 — invert per-project git SSH deploy keys into an org-scoped
-- "Private Keys" pool. `workspace_ssh_keys` becomes the source of truth;
-- `project_git_credentials` reshapes into a thin (project_id, ssh_key_id)
-- reference. Ciphertext moves verbatim — no vault access, no decrypt, at
-- migration time.
BEGIN;

CREATE TABLE "workspace_ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"source" text NOT NULL,
	"key_type" text DEFAULT 'ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"private_key_enc" bytea NOT NULL,
	"fingerprint" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_ssh_keys" ADD CONSTRAINT "workspace_ssh_keys_org_id_organizations_id_fk"
	FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_ssh_keys" ADD CONSTRAINT "workspace_ssh_keys_created_by_users_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "workspace_ssh_keys_org_id_idx" ON "workspace_ssh_keys" USING btree ("org_id");
--> statement-breakpoint

-- Fold existing per-project rows into the pool, deduped per org by
-- fingerprint (or, for legacy rows with no captured fingerprint, by the
-- public_key+ciphertext pair — the same physical key never gets two pool
-- rows). Name defaults to the owning project's slug (first writer wins the
-- dedup group).
INSERT INTO "workspace_ssh_keys" (id, org_id, name, source, key_type, public_key, private_key_enc, fingerprint, created_by, created_at, updated_at)
SELECT DISTINCT ON (p.org_id, COALESCE(gc.fingerprint, gc.public_key || ':' || encode(gc.private_key_enc, 'hex')))
	gen_random_uuid(), p.org_id, p.slug, gc.source, 'ed25519', gc.public_key, gc.private_key_enc, gc.fingerprint, gc.created_by, gc.created_at, gc.updated_at
FROM "project_git_credentials" gc
JOIN "projects" p ON p.id = gc.project_id
ORDER BY p.org_id, COALESCE(gc.fingerprint, gc.public_key || ':' || encode(gc.private_key_enc, 'hex')), gc.created_at;
--> statement-breakpoint

ALTER TABLE "project_git_credentials" ADD COLUMN "ssh_key_id" uuid;
--> statement-breakpoint

-- Rewire every existing reference to its folded pool row: match on fingerprint
-- when present, else fall back to the same public_key+ciphertext pair used
-- for the dedup above.
UPDATE "project_git_credentials" gc
SET "ssh_key_id" = wk.id
FROM "projects" p, "workspace_ssh_keys" wk
WHERE gc.project_id = p.id
	AND wk.org_id = p.org_id
	AND (
		(gc.fingerprint IS NOT NULL AND wk.fingerprint = gc.fingerprint)
		OR (gc.fingerprint IS NULL AND wk.public_key = gc.public_key AND wk.private_key_enc = gc.private_key_enc)
	);
--> statement-breakpoint

-- Safety gate: every pre-existing row must now have a pool reference before we
-- drop the secret columns it used to carry. A non-empty result aborts the
-- migration (division by zero) rather than silently orphaning a project's
-- git access.
DO $$
DECLARE orphan_count integer;
BEGIN
	SELECT count(*) INTO orphan_count FROM "project_git_credentials" WHERE "ssh_key_id" IS NULL;
	IF orphan_count > 0 THEN
		RAISE EXCEPTION 'migration 0150: % project_git_credentials row(s) failed to map to a workspace_ssh_keys row', orphan_count;
	END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "project_git_credentials" ALTER COLUMN "ssh_key_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_git_credentials" ADD CONSTRAINT "project_git_credentials_ssh_key_id_workspace_ssh_keys_id_fk"
	FOREIGN KEY ("ssh_key_id") REFERENCES "public"."workspace_ssh_keys"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_git_credentials_ssh_key_id_idx" ON "project_git_credentials" USING btree ("ssh_key_id");
--> statement-breakpoint

ALTER TABLE "project_git_credentials" DROP COLUMN "source";
--> statement-breakpoint
ALTER TABLE "project_git_credentials" DROP COLUMN "public_key";
--> statement-breakpoint
ALTER TABLE "project_git_credentials" DROP COLUMN "private_key_enc";
--> statement-breakpoint
ALTER TABLE "project_git_credentials" DROP COLUMN "fingerprint";
--> statement-breakpoint

CREATE UNIQUE INDEX "workspace_ssh_keys_org_fingerprint_uq" ON "workspace_ssh_keys" USING btree ("org_id","fingerprint") WHERE "fingerprint" IS NOT NULL;

COMMIT;
