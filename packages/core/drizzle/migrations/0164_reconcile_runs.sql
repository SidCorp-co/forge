-- ISS-801 (Update Pipeline stage ②) — Reconcile runs: per-project Master agent
-- state machine. One row per reconcile attempt. The partial unique index
-- enforces the serialize-per-project invariant (at most one active run per
-- project at status IN ('pending','running','verifying')).
--
-- Reconcile job types ('reconcile', 'verify_skill') are added to the
-- jobs.type CHECK constraint. The bundle column freezes all 12 input items at
-- trigger time (C5 input-determinism). last_good_body is captured at trigger;
-- it is the body restored on any failure path (ISS-795 §9.7).

CREATE TABLE "reconcile_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"packet_id" text,
	"skill_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict" text,
	"gate" text,
	"bundle" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"candidate_body" text,
	"candidate_hash" text,
	"last_good_body" text,
	"last_good_hash" text,
	"verifier_votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"refusal_reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_skill_id_skills_id_fk"
	FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "reconcile_runs_active_project_uq" ON "reconcile_runs" USING btree ("project_id")
	WHERE status IN ('pending','running','verifying');
--> statement-breakpoint
CREATE INDEX "reconcile_runs_project_created_idx" ON "reconcile_runs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX "reconcile_runs_packet_idx" ON "reconcile_runs" USING btree ("packet_id");
