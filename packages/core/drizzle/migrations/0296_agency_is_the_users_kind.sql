-- ISS-1137 — an agent IS a user (`users.kind = 'agent'`) and its credential is a row in the
-- same token table as a person's, so the owner's kind answers "person or agent" completely.
-- These two columns were a denormalised second copy of that answer, written at insert from a
-- guess: the door handed `null` for a person's own token and `actorAgency` read `null` as
-- 'agent', so every issue a person filed from their own terminal was stored as an agent's.
--
-- Dropped rather than backfilled, and the direction is deliberate. Every row these columns
-- describe carries a `created_by_id` / `author_id` whose `users.kind` gives the true answer
-- directly, and the stored values are the output of the defective guess — carrying them
-- forward would carry the defect forward. This is destructive: running it backwards restores
-- the columns empty. That is the intent, not a cost being accepted.
ALTER TABLE "comments" DROP COLUMN "author_agency";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "creator_agency";
