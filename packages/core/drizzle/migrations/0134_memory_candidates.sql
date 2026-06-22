-- ISS-534 — memory_candidates table for continuous-learning observer.
-- Separate from `memories` — pre-memory staging with confidence accrual.

CREATE TABLE IF NOT EXISTS "memory_candidates" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id"     uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "signal_type"    text NOT NULL CHECK ("signal_type" IN ('reopen_loop','repeated_fix_type','handoff_gap_rescue')),
  "signal_key"     text NOT NULL,
  "status"         text NOT NULL DEFAULT 'accruing' CHECK ("status" IN ('accruing','graduated','accepted','rejected')),
  "confidence"     numeric(3,2) NOT NULL DEFAULT 0.30,
  "evidence_count" integer NOT NULL DEFAULT 1,
  "evidence"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary"        text NOT NULL,
  "graduated_at"   timestamp with time zone,
  "reviewed_at"    timestamp with time zone,
  "archived_at"    timestamp with time zone,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "memory_candidates_project_signal_key_uq"
  ON "memory_candidates" ("project_id", "signal_type", "signal_key");

CREATE INDEX "memory_candidates_project_status_idx"
  ON "memory_candidates" ("project_id", "status");

CREATE INDEX "memory_candidates_archived_idx"
  ON "memory_candidates" ("archived_at");
