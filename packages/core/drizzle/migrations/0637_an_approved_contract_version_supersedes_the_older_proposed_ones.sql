-- Approving a contract version decides every older proposed version of that contract as superseded
-- by it (ISS-1056): before this, `ecosystem/standing/standing.ts:pendingOf` stopped reading them once
-- a newer version was approved, and they stood at `proposed` forever, decided by nobody. The check
-- takes the new value; the update settles the versions already left behind, each superseded by the
-- newest approved version recorded after it, decided as that approval was.
--
-- ROLLBACK: UPDATE "contract_versions" SET "approval" = 'proposed', "decided_by" = NULL,
-- "decided_as" = NULL, "decided_at" = NULL, "decision_reason" = NULL WHERE "approval" = 'superseded';
-- then restore the check without 'superseded'.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "contract_versions" DROP CONSTRAINT IF EXISTS "contract_versions_approval_chk";--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_approval_chk" CHECK ("approval" IN ('proposed', 'approved', 'returned', 'superseded'));--> statement-breakpoint
UPDATE "contract_versions" AS v
   SET "approval" = 'superseded',
       "decided_by" = a."decided_by",
       "decided_as" = a."decided_as",
       "decided_at" = a."decided_at",
       "decision_reason" = 'superseded by ' || a."version" || ', approved after it was recorded'
  FROM (
    SELECT p."provider_project_id", p."contract_slug", p."version" AS "proposed",
           n."version", n."decided_by", n."decided_as", n."decided_at",
           row_number() OVER (
             PARTITION BY p."provider_project_id", p."contract_slug", p."version"
             ORDER BY n."recorded_at" DESC
           ) AS "rank"
      FROM "contract_versions" p
      JOIN "contract_versions" n
        ON n."provider_project_id" = p."provider_project_id"
       AND n."contract_slug" = p."contract_slug"
       AND n."approval" = 'approved'
       AND n."decided_as" IN ('person', 'agent')
       AND n."recorded_at" > p."recorded_at"
     WHERE p."approval" = 'proposed'
  ) AS a
 WHERE a."rank" = 1
   AND v."provider_project_id" = a."provider_project_id"
   AND v."contract_slug" = a."contract_slug"
   AND v."version" = a."proposed"
   AND v."approval" = 'proposed';
