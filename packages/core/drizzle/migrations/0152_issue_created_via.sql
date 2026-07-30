-- ISS-756 — `issues.created_via`: server-derived creation channel, distinct
-- from `reported_by` (client-writable free text, so it can't carry a trusted
-- "who/what created this" label). NULL = legacy row, treated as human.

ALTER TABLE "issues" ADD COLUMN "created_via" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_via_chk"
	CHECK (created_via IS NULL OR created_via IN ('web','mcp','pipeline','schedule','system'));
