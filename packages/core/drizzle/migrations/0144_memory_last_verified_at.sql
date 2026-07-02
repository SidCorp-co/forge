-- ISS-603: recall-feedback loop.
-- Stamped when an agent verifies a memory row against live code
-- (forge_memory.feedback verdict=confirmed). The decay job treats it as
-- activity so a recently-confirmed row is never archived as unused.
-- Nullable: existing rows have never been verified.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_verified_at" timestamp with time zone;
