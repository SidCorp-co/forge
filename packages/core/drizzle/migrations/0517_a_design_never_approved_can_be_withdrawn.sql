-- A design no revision of which was ever approved can be withdrawn (machine `workflow_design`
-- version 3): project_workflows.design_status widens to `withdrawn`, a terminal state entered from
-- draft, proposed or returned and logged in kernel_transitions like every other move. Every stored
-- row holds NULL or one of the four statuses the CHECK already keeps, so none can fail it.
--
-- ROLLBACK: once no row reads `withdrawn` (move each back to the status its last kernel_transitions
-- row came from), restore the four-status project_workflows_design_status_chk.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "project_workflows" DROP CONSTRAINT IF EXISTS "project_workflows_design_status_chk";--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_design_status_chk" CHECK ("project_workflows"."design_status" IS NULL OR "project_workflows"."design_status" IN ('draft', 'proposed', 'approved', 'returned', 'withdrawn'));
