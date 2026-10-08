-- ISS-1282 — a release is closed by a reading Forge took when the agent asked it to look, so the
-- reading is kept: one row per look, holding what each live deploy binding that declares a probe
-- was serving and the bindings that declare none (`unread`). A finish judges these rows and takes
-- no reading of its own, and the agent's say-so is never one.
--
-- Additive: a new table nothing else reads, so no row of any existing table moves. A run deleted
-- takes its readings with it (ON DELETE CASCADE), the way `release_attempts` does.
-- Rollback: the table can stay unread, or `DROP TABLE release_readings`.
CREATE TABLE "release_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by" uuid NOT NULL,
	"bindings" jsonb NOT NULL,
	"unread" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "release_readings" ADD CONSTRAINT "release_readings_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_readings_run_idx" ON "release_readings" USING btree ("run_id","taken_at");
