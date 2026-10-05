-- ISS-219. Two invariants the review found unenforced.
--
-- UC15 redaction deletes the reporter's words everywhere: `where_seen` and the reasons the reporter
-- typed (their own decisions, and every verify or reopen note) become the placeholder
-- `reporter data deleted`. `where_seen` keeps a value because `feedback_arc_chk` needs one on a screen
-- item. Decisions stay insert-only except for exactly that one rewrite of `reason`, and items already
-- redacted are brought to the same state before the check pins it.
--
-- `project_workflows.design_status` is the `workflow_design` machine (`@forge/contracts/design-status`):
-- like every other machine's status it is written only by the kernel transition.

CREATE OR REPLACE FUNCTION "feedback_decision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "feedback" WHERE "id" = OLD."feedback_id") THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."reason" = 'reporter data deleted'
     AND (to_jsonb(NEW) - 'reason') = (to_jsonb(OLD) - 'reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FEEDBACK_DECISION_IMMUTABLE: a decision on feedback % is insert-only; a new decision writes a new row', OLD."feedback_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
UPDATE "feedback_decisions" d SET "reason" = 'reporter data deleted'
  FROM "feedback" f
 WHERE f."id" = d."feedback_id" AND f."redacted_at" IS NOT NULL AND d."reason" IS NOT NULL
   AND d."reason" <> 'reporter data deleted'
   AND (d."decided_by" = f."reported_by" OR d."decision" IN ('verified', 'reopened'));--> statement-breakpoint
UPDATE "feedback" SET "where_seen" = 'reporter data deleted'
 WHERE "redacted_at" IS NOT NULL AND "where_seen" IS NOT NULL AND "where_seen" <> 'reporter data deleted';--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT "feedback_redacted_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_redacted_chk" CHECK ("feedback"."redacted_at" IS NULL OR ("feedback"."body" IS NULL AND "feedback"."redacted_by" IS NOT NULL AND ("feedback"."where_seen" IS NULL OR "feedback"."where_seen" = 'reporter data deleted')));--> statement-breakpoint
SELECT forge_guard_status_column('project_workflows', 'design_status', 'workflow_design');
