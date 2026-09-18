-- ISS-1093 — "was this write an agent or a person" is answered by the CREDENTIAL,
-- not by the call channel. `issues.created_via` is stamped by the door (REST writes
-- 'web', MCP writes 'mcp'), so a master holding a person's PAT filed 20 rows that the
-- issue list showed as typed by the org owner while the activity log for those same
-- rows recorded an agent.
--
-- No DEFAULT, deliberately. `0193_activity_actor_agency.sql` added its column with
-- DEFAULT 'human' and thereby asserted a falsehood over every historical row, which is
-- why its read path has to OR the column with a type-derived floor. This column carries
-- no such debt: NULL means "no evidence", and that is what lets a stored value say
-- 'human' and be believed.
ALTER TABLE "issues" ADD COLUMN "creator_agency" text;
--> statement-breakpoint
-- One-way backfill, and the direction is the whole point. The evidence already exists:
-- the `issue.created` activity row for each issue carries the agency the credential
-- established. Copying 'agent' repairs the reported rows. Copying 'human' is forbidden
-- because `activity_log.actor_agency` DEFAULTs to 'human' over every row written before
-- migration 0193, so that direction would write a claim nothing ever established. Rows
-- left NULL fall back to the channel floor, which is exactly their behaviour today.
UPDATE "issues" i
   SET "creator_agency" = 'agent'
  FROM "activity_log" a
 WHERE a."issue_id" = i."id"
   AND a."action" = 'issue.created'
   AND a."actor_agency" = 'agent';
