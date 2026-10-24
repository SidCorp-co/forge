-- A suggestion carries why it is proposed and the earlier suggestion it supersedes (ISS-568, FB-139,
-- REQ-8 BC-1). A re-proposal had nowhere to answer the rejection it follows: the create body was strict
-- with neither field, so the answer went into a breakdown slice's description, which the accept copies
-- into the issue it files. Both stay on the suggestion row; no accept reads them.
--
-- `supersedes_id` names a suggestion of the same project (core refuses another project's by name
-- before the insert); deleting the earlier row clears the link rather than the row naming it. No row
-- is backfilled: nothing before this recorded either value, and null reads as "none given".
--
-- ROLLBACK: drop the two columns; every rationale and supersedes link written since is lost.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "rationale" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN IF NOT EXISTS "supersedes_id" uuid REFERENCES "suggestions"("id") ON DELETE SET NULL;
