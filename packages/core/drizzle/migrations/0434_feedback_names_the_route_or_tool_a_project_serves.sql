-- ISS-279 / FB-91: feedback about a programmatic surface had no target but a Screen, so an item about
-- Autoflow's MCP tool save_backend_workflow was filed as the screen "MCP tool save_backend_workflow".
-- An item can now be about a route or tool the project serves: an element of a version of an openapi
-- or mcp-tools contract the project itself provides, held by a real foreign key onto that version and
-- counted as the sixth member of the exclusive target arc. Every existing row has none of the three
-- columns, so the rebuilt arc check holds for each of them as it did before.
--
-- ROLLBACK: ALTER TABLE feedback DROP CONSTRAINT feedback_arc_chk, DROP CONSTRAINT
-- feedback_endpoint_target_chk, DROP CONSTRAINT feedback_endpoint_contract_version_fk, DROP COLUMN
-- endpoint_contract_slug, DROP COLUMN endpoint_contract_version, DROP COLUMN endpoint_element; then
-- re-add feedback_arc_chk as 0354 wrote it (refused while any row has an endpoint).

ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "endpoint_contract_slug" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "endpoint_contract_version" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "endpoint_element" text;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_endpoint_target_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_endpoint_target_chk" CHECK (num_nonnulls("feedback"."endpoint_contract_slug", "feedback"."endpoint_contract_version", "feedback"."endpoint_element") IN (0, 3));--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_endpoint_contract_version_fk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_endpoint_contract_version_fk" FOREIGN KEY ("project_id","endpoint_contract_slug","endpoint_contract_version") REFERENCES "public"."contract_versions"("provider_project_id","contract_slug","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_arc_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_arc_chk" CHECK (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version", "feedback"."endpoint_element") = 1 OR (num_nonnulls("feedback"."requirement_id", "feedback"."issue_id", "feedback"."release_run_id", "feedback"."workflow_id", "feedback"."contract_version", "feedback"."endpoint_element") = 0 AND "feedback"."where_seen" IS NOT NULL));
