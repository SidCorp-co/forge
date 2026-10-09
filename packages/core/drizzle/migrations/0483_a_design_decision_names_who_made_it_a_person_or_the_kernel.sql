-- A design revision's decision names who made it (REQ-41 BC-23, VISION: state-never-lies). A pin-only
-- revision is approved by Forge's kernel, and the row used to have to name a user, so it would have said
-- a person approved what no person did. `decided_kind` is `person` (names its user) or `kernel`
-- (names none); `decided_by_user` becomes nullable. Existing decided rows are people's.
--
-- ROLLBACK: refused while a kernel row exists (it has no user to name); then
-- DROP CONSTRAINT project_workflow_designs_decided_chk, re-add the 0342 one, SET NOT NULL is not
-- needed (the column was nullable until decided); DROP COLUMN decided_kind.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "project_workflow_designs" ADD COLUMN IF NOT EXISTS "decided_kind" text;
--> statement-breakpoint
UPDATE "project_workflow_designs" SET "decided_kind" = 'person' WHERE "decision" IS NOT NULL AND "decided_kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_workflow_designs" DROP CONSTRAINT IF EXISTS "project_workflow_designs_decided_chk";
--> statement-breakpoint
ALTER TABLE "project_workflow_designs" ADD CONSTRAINT "project_workflow_designs_decided_chk" CHECK (
  ("decision" IS NULL) = ("decided_at" IS NULL)
  AND (("decision" IS NULL AND "decided_kind" IS NULL AND "decided_by_user" IS NULL)
    OR ("decision" IS NOT NULL AND (
         ("decided_kind" = 'person' AND "decided_by_user" IS NOT NULL)
      OR ("decided_kind" = 'kernel' AND "decided_by_user" IS NULL))))
);
