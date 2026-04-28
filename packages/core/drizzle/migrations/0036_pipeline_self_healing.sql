-- v0.1.10 (ISS-306) — pipeline self-healing.
--
-- Adds failure classification + recovery telemetry so the new sweeper
-- (packages/core/src/pipeline/sweeper.ts) can decide whether to re-fire the
-- orchestrator (transient/unknown failure with budget remaining) or
-- escalate the issue to `pipeline_failed` (permanent failure or recovery
-- budget exhausted). All columns are additive + nullable so the deploy is
-- reversible.

ALTER TABLE "jobs" ADD COLUMN "failure_kind" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "failure_meta" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "classifier_version" integer;--> statement-breakpoint

ALTER TABLE "issues" ADD COLUMN "recovery_attempts" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_recovery_at" timestamptz;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "recovery_window_started_at" timestamptz;--> statement-breakpoint

CREATE INDEX "issues_pipeline_recovery_idx" ON "issues" USING btree ("status", "last_recovery_at");
