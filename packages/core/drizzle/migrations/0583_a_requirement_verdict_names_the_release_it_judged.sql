-- A business criterion judged at the requirement on the release its agent recorded (ISS-900, FB-479).
-- A project whose owner rules out commit fields (agenfold's `release-is-the-agents-record`) reports
-- only a version, and its production declares no source probe, so a verdict naming a commit could
-- never be placed under what is live and no criterion ever counted. A verdict there names the release
-- version it was judged on instead, checked against the releases the project recorded as shipped.
-- A judged row names exactly one of the commit or the release; a skip names neither, as before.
--
-- No row is rewritten: every existing row names a commit or is a skip. ROLLBACK: drop the column
-- after restoring the old judged check (`commit_sha IS NOT NULL AND cardinality(evidence) > 0`).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" ADD COLUMN IF NOT EXISTS "release_version" text;--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" DROP CONSTRAINT IF EXISTS "requirement_criterion_verdicts_release_chk";--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" ADD CONSTRAINT "requirement_criterion_verdicts_release_chk" CHECK ("release_version" IS NULL OR "release_version" ~ '^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[a-z][a-z0-9]{0,15}\.[0-9]{1,9})?$');--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" DROP CONSTRAINT IF EXISTS "requirement_criterion_verdicts_judged_chk";--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" ADD CONSTRAINT "requirement_criterion_verdicts_judged_chk" CHECK (("verdict" = 'skipped' AND "commit_sha" IS NULL AND "release_version" IS NULL) OR ("verdict" <> 'skipped' AND ("commit_sha" IS NULL) <> ("release_version" IS NULL) AND cardinality("evidence") > 0));
