-- A storefront_draft verdict names every workflow draft its criterion rests on (ISS-613, FB-201,
-- FB-202; REQ-6 BC-2).
--
-- criterion_verdicts: `storefront_workflow_id` and `storefront_draft_version` named one workflow and
-- one draft, so a criterion proven over several workflows could carry the others only in prose, and
-- corroboration never read them. They are replaced by `storefront_drafts`, a jsonb array of
-- `{ workflowId, draftVersion }`: one to fifty parts, each workflow once, each id and version in the
-- shape the old columns held (`forge_storefront_drafts_well_formed`).
--
-- Every stored storefront_draft verdict is copied as a one-element array of the workflow and draft
-- it named, so it reads exactly as it did. A storefront_draft row missing either value cannot be
-- represented and aborts the deploy naming it. Nothing is deleted or widened to fit.
--
-- The 0360 CHECK passed a storefront_draft row with no environment or no corroboration, since a
-- NULL compared with `~` or `IN` reads unknown and a CHECK lets unknown through. The new CHECK reads
-- both through coalesce, so such a row is refused; one already stored aborts the deploy naming it.
--
-- ROLLBACK: add the two text columns back, copy `storefront_drafts->0` into them, drop
-- `storefront_drafts`, the function and the new CHECK, and restore the 0360 CHECK. A verdict written
-- after this migration naming more than one workflow loses every part but its first.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_storefront_drafts_well_formed(parts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN parts IS NULL OR jsonb_typeof(parts) <> 'array' THEN false
    WHEN jsonb_array_length(parts) NOT BETWEEN 1 AND 50 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(parts) AS p(part)
            -- a missing key reads NULL, and NOT NULL would let the part through: coalesce to false
            WHERE NOT coalesce(jsonb_typeof(part) = 'object'
                       AND (part - 'workflowId' - 'draftVersion') = '{}'::jsonb
                       AND jsonb_typeof(part -> 'workflowId') = 'string'
                       AND jsonb_typeof(part -> 'draftVersion') = 'string'
                       AND (part ->> 'workflowId') ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
                       AND (part ->> 'draftVersion') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', false))
     AND (SELECT count(DISTINCT part ->> 'workflowId') FROM jsonb_array_elements(parts) AS p(part))
         = jsonb_array_length(parts)
  END
$$;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "storefront_drafts" jsonb;--> statement-breakpoint
DO $$
DECLARE
  refused text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'criterion_verdicts' AND column_name = 'storefront_workflow_id'
  ) THEN
    RETURN;
  END IF;
  EXECUTE $q$
    SELECT string_agg(format('verdict %s on issue %s', id, issue_id), '; ')
      FROM criterion_verdicts
     WHERE identity_kind = 'storefront_draft'
       AND storefront_drafts IS NULL
       AND (storefront_workflow_id IS NULL OR storefront_draft_version IS NULL
            OR storefront_environment IS NULL OR corroboration IS NULL)
  $q$ INTO refused;
  IF refused IS NOT NULL THEN
    RAISE EXCEPTION 'STOREFRONT_DRAFT_UNREPRESENTABLE: % — a storefront_draft verdict names no workflow, no draft version, no environment or no corroboration, so it cannot be kept as the list of workflow drafts it was judged on; correct the row by hand, then deploy again.', refused;
  END IF;
  EXECUTE $q$
    UPDATE criterion_verdicts
       SET storefront_drafts = jsonb_build_array(jsonb_build_object(
             'workflowId', storefront_workflow_id, 'draftVersion', storefront_draft_version))
     WHERE identity_kind = 'storefront_draft' AND storefront_drafts IS NULL
  $q$;
END $$;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_storefront_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_storefront_chk" CHECK (("criterion_verdicts"."identity_kind" = 'storefront_draft' AND forge_storefront_drafts_well_formed("criterion_verdicts"."storefront_drafts") AND coalesce("criterion_verdicts"."storefront_environment", '') ~ '^[a-z][a-z0-9-]{0,62}$' AND coalesce("criterion_verdicts"."corroboration", '') IN ('corroborated', 'uncorroborated') AND ("criterion_verdicts"."corroboration" = 'corroborated' OR coalesce("criterion_verdicts"."corroboration_note", '') ~ '[^[:space:]]'))
        OR ("criterion_verdicts"."identity_kind" IS DISTINCT FROM 'storefront_draft' AND "criterion_verdicts"."storefront_drafts" IS NULL AND "criterion_verdicts"."storefront_environment" IS NULL AND "criterion_verdicts"."corroboration" IS NULL AND "criterion_verdicts"."corroboration_note" IS NULL));--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP COLUMN IF EXISTS "storefront_workflow_id";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP COLUMN IF EXISTS "storefront_draft_version";
