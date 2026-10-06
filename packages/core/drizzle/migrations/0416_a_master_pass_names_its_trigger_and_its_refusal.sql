-- A master pass names what started it and whether it ran. `trigger` is 'nudge' for a turn the runner
-- asked for and 'unprompted' for one it saw start without asking (a person typing at the pane, a
-- task notification); every row before this was opened by a nudge, which is the only path that
-- opened one, so the default is the fact for them. `refusal` is set on close when the turn was
-- refused before it ran (a usage limit, say), so a refused pass never reads as an idle one.
--
-- ROLLBACK: ALTER TABLE master_passes DROP COLUMN refusal, DROP COLUMN trigger, and restore
-- master_pass_guard() from 0366.

ALTER TABLE "master_passes" ADD COLUMN "trigger" text DEFAULT 'nudge' NOT NULL;--> statement-breakpoint
ALTER TABLE "master_passes" ADD COLUMN "refusal" jsonb;--> statement-breakpoint
ALTER TABLE "master_passes" ADD CONSTRAINT "master_passes_trigger_chk" CHECK ("master_passes"."trigger" IN ('nudge', 'unprompted'));--> statement-breakpoint
ALTER TABLE "master_passes" ADD CONSTRAINT "master_passes_refusal_shape_chk" CHECK ("master_passes"."refusal" IS NULL OR ("master_passes"."ended_at" IS NOT NULL AND jsonb_typeof("master_passes"."refusal") = 'object' AND cardinality("master_passes"."dispatched") = 0 AND cardinality("master_passes"."parked") = 0 AND "master_passes"."skipped" = '[]'::jsonb));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "master_pass_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "agent_sessions" WHERE "id" = OLD."master_session_id")
       OR NOT EXISTS (SELECT 1 FROM "projects" WHERE "id" = OLD."project_id") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: pass % of master session % is never deleted; it goes with its session or project', OLD."id", OLD."master_session_id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ended_at" IS NOT NULL THEN
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: pass % ended at %, and a closed pass is final', OLD."id", OLD."ended_at" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."master_session_id" IS DISTINCT FROM OLD."master_session_id"
     OR NEW."verb" IS DISTINCT FROM OLD."verb"
     OR NEW."issue_key" IS DISTINCT FROM OLD."issue_key"
     OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
    RAISE EXCEPTION 'MASTER_PASS_IMMUTABLE: open pass % changes only by closing it (ended_at, dispatched, skipped, parked, refusal)', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
