-- Org-level permission tier (clean break, single authz logic).
--
-- Model after this migration:
--   * organizations + organization_members (owner|admin|member). Org owner/admin
--     derive implicit project `admin` on every project of the org; org `member`
--     derives nothing (project access still needs a project_members row).
--   * EVERY project belongs to exactly one org (org_id NOT NULL). Each existing
--     user gets a personal org (is_personal=true, partial-unique per user) and
--     their projects are backfilled into it.
--   * projects.owner_id is RENAMED to created_by and loses all authz semantics
--     (audit only). The old implicit "project owner" becomes an explicit
--     project_members admin row + org ownership of the personal org.
--   * project_members.role enum becomes admin|member|viewer ('owner' rows are
--     rewritten to 'admin'; same for pending project_invitations).
--   * Existing active PATs are grandfathered with the 'admin' scope — the scope
--     existed but was never enforced, so every pre-0106 PAT could already
--     perform admin mutations; enforcement lands with this migration and must
--     not silently break existing tokens. New PATs default to read,write.
--
-- Hand-written because drizzle-kit generate is blocked by a pre-existing
-- meta-snapshot collision (see 0084–0105 headers); the runtime migrator applies
-- this from _journal.json.

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "is_personal" boolean NOT NULL DEFAULT false,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_personal_owner_uq"
  ON "organizations" ("created_by") WHERE is_personal = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_members" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY ("org_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_members_user_id_idx" ON "organization_members" ("user_id");
--> statement-breakpoint
-- Backfill: one personal org per existing user (idempotent via the partial unique).
INSERT INTO "organizations" ("id", "slug", "name", "is_personal", "created_by")
SELECT gen_random_uuid(), 'personal-' || u."id", split_part(u."email", '@', 1), true, u."id"
FROM "users" u
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "organization_members" ("org_id", "user_id", "role")
SELECT o."id", o."created_by", 'owner'
FROM "organizations" o
WHERE o."is_personal" = true
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Attach every project to its creator's personal org, then lock the column.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "org_id" uuid REFERENCES "organizations"("id") ON DELETE restrict;
--> statement-breakpoint
UPDATE "projects" p
SET "org_id" = o."id"
FROM "organizations" o
WHERE o."created_by" = p."owner_id" AND o."is_personal" = true AND p."org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_org_id_idx" ON "projects" ("org_id");
--> statement-breakpoint
-- The old implicit owner becomes an explicit project admin (covers projects
-- whose owner never had a project_members row — MCP-created ones).
INSERT INTO "project_members" ("user_id", "project_id", "role")
SELECT p."owner_id", p."id", 'admin'
FROM "projects" p
ON CONFLICT ("user_id", "project_id") DO UPDATE SET "role" = 'admin';
--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "owner_id" TO "created_by";
--> statement-breakpoint
ALTER INDEX IF EXISTS "projects_owner_id_idx" RENAME TO "projects_created_by_idx";
--> statement-breakpoint
-- Project role enum shrinks to admin|member|viewer.
UPDATE "project_members" SET "role" = 'admin' WHERE "role" = 'owner';
--> statement-breakpoint
UPDATE "project_invitations" SET "role" = 'admin' WHERE "role" = 'owner';
--> statement-breakpoint
-- Grandfather: pre-0106 PATs could already perform admin mutations (scope was
-- declared but unenforced) — keep them working under the new enforcement.
UPDATE "personal_access_tokens"
SET "scopes" = array_append("scopes", 'admin')
WHERE "revoked_at" IS NULL AND NOT ('admin' = ANY ("scopes"));
