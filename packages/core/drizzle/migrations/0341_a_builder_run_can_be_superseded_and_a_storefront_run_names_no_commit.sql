ALTER TABLE "ecosystem_builder_runs" DROP CONSTRAINT "ecosystem_builder_runs_trigger_chk";--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" DROP CONSTRAINT "ecosystem_builder_runs_sha_chk";--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ALTER COLUMN "trigger_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ADD CONSTRAINT "ecosystem_builder_runs_trigger_chk" CHECK ("ecosystem_builder_runs"."trigger" IN ('joined', 'push', 'manual'));--> statement-breakpoint
ALTER TABLE "ecosystem_builder_runs" ADD CONSTRAINT "ecosystem_builder_runs_sha_chk" CHECK ("ecosystem_builder_runs"."trigger_sha" IS NULL OR "ecosystem_builder_runs"."trigger_sha" ~ '^[0-9a-f]{40}$');