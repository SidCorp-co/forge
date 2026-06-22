-- ISS-554 — improvement_message_drafts table + promote status on memory_candidates.
-- Adds a DB-backed draft store for bottom-up improvement proposals seeded by the
-- curator "promote" action. Also extends the memory_candidates.status CHECK to
-- include 'promoted' (a distinct terminal state from 'accepted'/'rejected').

-- 1. Extend memory_candidates.status to allow 'promoted'.
ALTER TABLE "memory_candidates"
  DROP CONSTRAINT IF EXISTS "memory_candidates_status_check";

ALTER TABLE "memory_candidates"
  ADD CONSTRAINT "memory_candidates_status_check"
  CHECK ("status" IN ('accruing','graduated','accepted','rejected','promoted'));

-- 2. Create improvement_message_drafts table.
CREATE TABLE IF NOT EXISTS "improvement_message_drafts" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key"               text NOT NULL,
  "title"             text NOT NULL,
  "message"           text NOT NULL,
  "rationale"         text NOT NULL,
  "applies_when"      text,
  "applies_to_skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "category"          text NOT NULL DEFAULT 'general',
  "status"            text NOT NULL DEFAULT 'pending_review'
                      CHECK ("status" IN ('pending_review','published','dismissed')),
  "source"            text NOT NULL DEFAULT 'bottom_up'
                      CHECK ("source" IN ('bottom_up')),
  "candidate_id"      uuid REFERENCES "memory_candidates"("id") ON DELETE SET NULL,
  "signal_key"        text NOT NULL,
  "source_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "improvement_message_drafts_key_uq"
  ON "improvement_message_drafts" ("key");

CREATE INDEX "improvement_message_drafts_status_idx"
  ON "improvement_message_drafts" ("status");

CREATE INDEX "improvement_message_drafts_candidate_idx"
  ON "improvement_message_drafts" ("candidate_id");

CREATE INDEX "improvement_message_drafts_signal_key_idx"
  ON "improvement_message_drafts" ("signal_key");
