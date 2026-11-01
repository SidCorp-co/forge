-- A cleanup debt keeps the evidence given on it (ISS-839): what someone found about an open debt, in
-- their name, which every later cleanup brief and ledger read carries beside the debt, so a cleanup
-- run weighs it without having to recall it from project memory. Append-only; it goes with its debt.
--
-- ROLLBACK: DROP TABLE "delivery_debt_evidence"; the briefs then carry the ledger's own rows alone.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_debt_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"debt_id" uuid NOT NULL REFERENCES "delivery_debts"("id") ON DELETE cascade,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"evidence" text NOT NULL,
	"recorded_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_debt_evidence_debt_idx" ON "delivery_debt_evidence" USING btree ("debt_id", "created_at");
