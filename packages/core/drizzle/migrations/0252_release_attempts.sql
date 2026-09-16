-- ISS-1042 — `release_attempts`: every act a release run made, and what came back.
--
-- Between `createReleaseBatch` and `finish` core recorded nothing at all, so a
-- release that merged, deployed twice, failed a probe and deployed again left
-- one `pipeline_runs` row saying `running` and a transcript on whichever box
-- held it. This table is what makes a release readable by somebody other than
-- the session that ran it.
--
-- Additive in every statement: one new table, its unique constraint, its
-- foreign key and one index. No existing column, constraint or row is touched.
-- Running it backwards is `DROP TABLE release_attempts` plus removing the
-- matching `_journal.json` entry, and nothing that existed before is lost —
-- nothing outside `release-batch/ledger.ts` writes it and nothing outside
-- `release-batch/state.ts` and the web surface reads it.
--
-- cm:guard the journal `when` for this entry is max(when) + 86400000 and NEVER
-- a real timestamp. `src/db/migrate.ts` reads the single highest `created_at`
-- already applied and skips every lower entry SILENTLY and forever, so a
-- generated real timestamp lands below the entries already in the target
-- database and the container starts serving new code against an old schema
-- (ISS-807). Gated by `db/migrations-journal.test.ts`.
CREATE TABLE "release_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"commit" text,
	"provider_ref" text,
	"health" text,
	"identity" text,
	"verdict" text,
	"verdict_reason" text,
	"readings" jsonb,
	"account" text,
	"log_tail" text,
	"log_tail_truncated" boolean DEFAULT false NOT NULL,
	"log_tail_read_at" timestamp with time zone,
	"log_tail_read_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "release_attempts_run_key_uq" UNIQUE("run_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "release_attempts" ADD CONSTRAINT "release_attempts_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_attempts_run_idx" ON "release_attempts" USING btree ("run_id","started_at");