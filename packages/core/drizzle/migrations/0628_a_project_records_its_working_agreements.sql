-- REQ-90 (ISS-1110, ISS-1112) — a project's working agreements: each change a project makes to them
-- (an override of a Forge default, an agreement of its own, a restore, a retirement) is a revision
-- of its own, owned by `agreements` (`packages/core/src/db/schema-agreements.ts:projectAgreementRevisions`).
-- Insert-only, so a run's recorded revision can always be read back; a row goes only with its
-- project. Forge's own defaults ship in core's code and are not rows.
--
-- And a working agreement is one more kind of source that reaches a run
-- (`run_context_reaches.kind` takes `agreement`), so a run records which agreement revisions it got.
--
-- No row is backfilled: no project has changed an agreement before this lands.
--
-- ROLLBACK: DROP TABLE IF EXISTS "project_agreement_revisions"; DROP FUNCTION IF EXISTS project_agreement_revision_guard();
--           DELETE FROM "run_context_reaches" WHERE "kind" = 'agreement';
--           ALTER TABLE "run_context_reaches" DROP CONSTRAINT "run_context_reaches_kind_chk",
--             ADD CONSTRAINT "run_context_reaches_kind_chk" CHECK ("kind" IN ('rule', 'knowledge', 'lesson', 'memory'));

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_agreement_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"revision" integer NOT NULL,
	"change" text NOT NULL,
	"name" text,
	"rule" text,
	"detail" text,
	"condition" jsonb,
	"reason" text NOT NULL,
	"base_revision" integer,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_agreement_revisions_change_chk" CHECK ("project_agreement_revisions"."change" IN ('override', 'addition', 'restore', 'retire')),
	CONSTRAINT "project_agreement_revisions_rule_chk" CHECK (("project_agreement_revisions"."change" IN ('override', 'addition')) = ("project_agreement_revisions"."rule" IS NOT NULL)),
	CONSTRAINT "project_agreement_revisions_reason_chk" CHECK (length(btrim("project_agreement_revisions"."reason")) > 0)
);--> statement-breakpoint
ALTER TABLE "project_agreement_revisions" DROP CONSTRAINT IF EXISTS "project_agreement_revisions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "project_agreement_revisions" ADD CONSTRAINT "project_agreement_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agreement_revisions" DROP CONSTRAINT IF EXISTS "project_agreement_revisions_actor_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_agreement_revisions" ADD CONSTRAINT "project_agreement_revisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_agreement_revisions_revision_uq" ON "project_agreement_revisions" USING btree ("project_id","slug","revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_agreement_revisions_project_idx" ON "project_agreement_revisions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION project_agreement_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'project_agreement_revisions: % is insert-only; a change to an agreement is a new revision', OLD.id;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_agreement_revisions_guard_trg ON "project_agreement_revisions";--> statement-breakpoint
CREATE TRIGGER project_agreement_revisions_guard_trg BEFORE UPDATE OR DELETE ON "project_agreement_revisions" FOR EACH ROW EXECUTE FUNCTION project_agreement_revision_guard();--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_kind_chk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_kind_chk" CHECK ("run_context_reaches"."kind" IN ('rule', 'knowledge', 'lesson', 'memory', 'agreement'));
