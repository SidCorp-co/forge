-- ISS-619 — humanize the "Pipeline wedge" notification.
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0120, 0125).
--
-- notifications.secondary_issue_id — a second, distinct issue reference for
-- notifications whose actionable target differs from issue_id (e.g. a
-- dependency-stall wedge: issue_id stays the wedged issue for interventions
-- metric attribution, secondary_issue_id is the blocker/child the user needs
-- to act on). Additive + idempotent.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "secondary_issue_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_secondary_issue_id_issues_id_fk" FOREIGN KEY ("secondary_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
