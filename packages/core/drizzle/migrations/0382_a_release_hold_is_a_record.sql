-- The automatic release's hold on an issue becomes a record owned by release (ISS-163): a
-- `release_holds` row per reason, the standing one with no `cleared_at`, in place of
-- `issues.session_context.releaseHold` and the comment posted beside it.
--
-- A stored hold on a row still waiting unclaimed at the gate is carried over, keeping the time it
-- was written. Every other stored hold is dropped and named by a NOTICE: one on a row that moved
-- on was already stale, and one missing a field was never read by the sweep. Neither is a fact the
-- next sweep cannot write again, since the sweep decides every waiting row afresh each tick.

CREATE TABLE "release_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
  "code" text NOT NULL,
  "reason" text NOT NULL,
  "owes" text NOT NULL,
  "waiting_for" text NOT NULL,
  "held_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone,
  CONSTRAINT "release_holds_owes_chk" CHECK ("owes" IN ('agent', 'human'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "release_holds_standing_uq" ON "release_holds" USING btree ("issue_id") WHERE cleared_at IS NULL;
--> statement-breakpoint
CREATE INDEX "release_holds_project_idx" ON "release_holds" USING btree ("project_id", "held_at") WHERE cleared_at IS NULL;
--> statement-breakpoint
INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for, held_at)
SELECT i.project_id, i.id,
       i.session_context #>> '{releaseHold,code}',
       i.session_context #>> '{releaseHold,reason}',
       i.session_context #>> '{releaseHold,owes}',
       i.session_context #>> '{releaseHold,waitingFor}',
       COALESCE((i.session_context #>> '{releaseHold,at}')::timestamptz, now())
  FROM issues i
 WHERE i.session_context ? 'releaseHold'
   AND i.status = 'awaiting_release'
   AND i.release_batch_run_id IS NULL
   AND btrim(COALESCE(i.session_context #>> '{releaseHold,code}', '')) <> ''
   AND btrim(COALESCE(i.session_context #>> '{releaseHold,reason}', '')) <> ''
   AND btrim(COALESCE(i.session_context #>> '{releaseHold,waitingFor}', '')) <> ''
   AND i.session_context #>> '{releaseHold,owes}' IN ('agent', 'human');
--> statement-breakpoint
DO $$
DECLARE
  dropped text;
BEGIN
  SELECT string_agg(i.id::text, ', ') INTO dropped
    FROM issues i
   WHERE i.session_context ? 'releaseHold'
     AND NOT EXISTS (SELECT 1 FROM release_holds h WHERE h.issue_id = i.id);
  IF dropped IS NOT NULL THEN
    RAISE NOTICE 'release_holds: a stored hold not carried over (stale or missing a field) on issues %', dropped;
  END IF;
END $$;
--> statement-breakpoint
UPDATE issues SET session_context = session_context - 'releaseHold'
 WHERE session_context ? 'releaseHold';
