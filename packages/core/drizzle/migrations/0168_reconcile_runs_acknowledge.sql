ALTER TABLE "reconcile_runs" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD COLUMN IF NOT EXISTS "acknowledged_by" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_acknowledged_by_users_id_fk"
		FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reconcile_runs_pending_gate_idx" ON "reconcile_runs" USING btree ("project_id") WHERE (status = 'decided' AND gate = 'human') OR (status = 'escalated' AND verdict = 'escalate' AND acknowledged_at IS NULL);