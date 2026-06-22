-- ISS-553 (C2) — post-job normalizer: feedback_reports → memory_candidates.
-- 1. Extend signal_type CHECK to include 'agent_self_report'.
-- 2. Add FK feedback_reports.candidate_id → memory_candidates.id ON DELETE SET NULL.

-- Alter the signal_type CHECK constraint (drop old, add new — idempotent DO block).
DO $$ BEGIN
  ALTER TABLE "memory_candidates"
    DROP CONSTRAINT IF EXISTS "memory_candidates_signal_type_check";
EXCEPTION WHEN undefined_object THEN NULL; END $$;
--> statement-breakpoint

-- Re-add with agent_self_report included.
DO $$ BEGIN
  ALTER TABLE "memory_candidates"
    ADD CONSTRAINT "memory_candidates_signal_type_check"
    CHECK ("signal_type" IN (
      'reopen_loop',
      'repeated_fix_type',
      'handoff_gap_rescue',
      'agent_self_report'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK: candidate_id → memory_candidates.id (set null on delete).
DO $$ BEGIN
  ALTER TABLE "feedback_reports"
    ADD CONSTRAINT "feedback_reports_candidate_id_fk"
    FOREIGN KEY ("candidate_id") REFERENCES "memory_candidates"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
