-- ISS-1228 — a run's wait is aged from when it began. `work_since` is when core first saw the run's
-- current work, blocker and wait; a snapshot repeating all three keeps it, one changing any of them
-- restamps it.
--
-- Core kept no earlier record of when a standing wait began, so an existing row is filled with its
-- `observed_at`, the last time core saw that state: a lower bound on how long it has waited, never
-- its true wait. The default lets a writer that does not name the column still insert.
ALTER TABLE "device_run_ledger" ADD COLUMN "work_since" timestamp with time zone;--> statement-breakpoint
UPDATE "device_run_ledger" SET "work_since" = "observed_at";--> statement-breakpoint
ALTER TABLE "device_run_ledger" ALTER COLUMN "work_since" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "device_run_ledger" ALTER COLUMN "work_since" SET NOT NULL;
