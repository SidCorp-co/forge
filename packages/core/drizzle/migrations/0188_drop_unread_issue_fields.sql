ALTER TABLE "issues" DROP COLUMN IF EXISTS "suggested_solution";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "ai_summary";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "ai_suggested_solution";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "ai_acceptance_criteria";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "ai_confidence";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "parent_issue_id";
