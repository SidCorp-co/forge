-- design-reconciliation `build`, workflow-step-health `d-node-lifecycle`: a build issue may name the
-- observed steps it removes, so a Not in design node decided delete reads cleaning while that issue
-- is open. NULL on every build linked before this column, which named only planned steps.
--
-- ROLLBACK: ALTER TABLE "workflow_builds" DROP COLUMN "observed_step_ids"; a delete build reads
-- decided again until the next observation.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD COLUMN "observed_step_ids" text[];
--> statement-breakpoint
-- project-onboarding `answer-lands`, `revise`: where an answered questionnaire item landed, the
-- proposed design revisions and suggestions that cite it. NULL on items no update has cited.
--
-- ROLLBACK: ALTER TABLE "agent_questions" DROP COLUMN "landed_in"; designs then read their linked
-- items from `affects` alone, with no cited revision.
ALTER TABLE "agent_questions" ADD COLUMN "landed_in" jsonb;
