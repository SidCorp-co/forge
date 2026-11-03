-- A forge-beta issue ported to forge-dev and the dev status last mirrored back onto it (ISS-923): one
-- row per beta issue, written by the `beta_port` schedule when it ports the issue or adopts a port
-- made by hand. The beta issue's id is another instance's, so it is text and no foreign key; the dev
-- issue's row is this instance's and the pair goes with it. No row exists before this migration.
--
-- ROLLBACK: DROP TABLE IF EXISTS "beta_port_pairs"; the next fire ports nothing twice (the beta
-- comment and the dev issue's first line still guard), and re-adopts each pair with no mirror record.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "beta_port_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"beta_issue_id" text NOT NULL,
	"beta_key" text NOT NULL,
	"beta_project_slug" text NOT NULL,
	"dev_issue_id" uuid NOT NULL,
	"last_mirrored_status" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "beta_port_pairs" DROP CONSTRAINT IF EXISTS "beta_port_pairs_dev_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD CONSTRAINT "beta_port_pairs_dev_issue_id_issues_id_fk" FOREIGN KEY ("dev_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "beta_port_pairs_beta_issue_uq" ON "beta_port_pairs" USING btree ("beta_issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_port_pairs_dev_issue_idx" ON "beta_port_pairs" USING btree ("dev_issue_id");
