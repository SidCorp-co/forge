-- ISS-654 — the Ops Console's Tier 1 thresholds and spend ceiling as operator
-- policy, one GLOBAL row.
--
-- Not `app_config`: that table is keyed `project_id UNIQUE` and the console is
-- cross-tenant. Not env vars either — the three `FORGE_ALERT_*` knobs this
-- supersedes are deleted in the same commit, so there is one place a threshold
-- is written and one place it is read.
--
-- The table ships EMPTY. `admin/thresholds.ts` declares the same defaults as
-- fallbacks, so a deploy that never PUTs behaves exactly as before this
-- migration; the first PUT inserts the singleton.
--
-- Roll back: DROP TABLE "admin_thresholds";

CREATE TABLE "admin_thresholds" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"stuck_job_seconds" integer DEFAULT 600 NOT NULL,
	"runner_starved_seconds" integer DEFAULT 300 NOT NULL,
	"spend_ceiling_usd_day" real,
	"spend_spike_multiple" real DEFAULT 2.5 NOT NULL,
	"schedule_fail_streak" integer DEFAULT 2 NOT NULL,
	"delivery_fail_rate_pct" integer DEFAULT 20 NOT NULL,
	"intervention_labels" jsonb DEFAULT '["kernel-hardening","onboarding"]'::jsonb NOT NULL,
	"ghost_runner_offline_days" integer DEFAULT 14 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_thresholds_singleton_ck" CHECK ("admin_thresholds"."id" = 'singleton')
);
--> statement-breakpoint
ALTER TABLE "admin_thresholds" ADD CONSTRAINT "admin_thresholds_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
