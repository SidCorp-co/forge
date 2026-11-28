-- ISS-1483. A room agent's ask of a master may open a NEW case in its thread: the agent declares that
-- a different need of the person begins here, and a case's rounds count from its latest opening.
-- Core never guesses that two asks of one thread are unrelated. Existing asks are not openings.
--
-- ROLLBACK: DROP COLUMN `opens_case` on `support_master_asks` (rounds then count the whole thread).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_master_asks" ADD COLUMN IF NOT EXISTS "opens_case" boolean NOT NULL DEFAULT false;
