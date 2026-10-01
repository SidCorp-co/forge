-- A schedule records who owns it, and a cron firing acts as that person (ISS-30): their role on
-- the project, cut to the box holder's, under a `turn:<session>` token. It ran under the personal
-- access token of whoever paired the box it landed on. The owner is whoever last saved the row.
--
-- Existing rows are owned by their project's creator: that is the account every cron firing has
-- already been recorded as (`schedules/dispatch.ts`, `loadCreatedBy`), so a row's owner is the
-- person its sessions already named, now acting with that person's own role rather than the box
-- holder's. A creator whose account is gone leaves the column null, and the schedule is refused by
-- name (`SCHEDULE_OWNER_GONE`) until an admin saves it again. Rollback is dropping the column.
ALTER TABLE "schedules" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "schedules" s
   SET "owner_id" = p."created_by"
  FROM "projects" p, "users" u
 WHERE p."id" = s."project_id"
   AND u."id" = p."created_by";
