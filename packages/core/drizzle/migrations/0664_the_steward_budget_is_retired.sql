-- ISS-1255: the steward's daily budget is retired. Its runner jobs take the box's run slots like every
-- other run (`devices/run-slots.ts:slotsFor`), and a per-item runaway guard replaced its turn cap, so
-- a project document's `steward.budget` decides nothing any more. From this change a write naming it
-- is refused STEWARD_BUDGET_RETIRED (`project-config/rules.ts:checkRetiredStewardBudget`); this strips
-- every stored one, so no document carries a cap that is silently not applied.
--
-- WHAT CHANGES. Each project document holding `steward.budget` loses that key, as a revision Forge
-- writes itself (revision + 1, `updated_by` NULL, as REQ-76 BC-13's own writes are). A budget of no
-- turns and no jobs let the steward do nothing at all, which `steward.enabled: false` now says, so
-- that document is turned off rather than switched on by the strip (an explicit `enabled` the budget
-- contradicted is overwritten). A `steward` key left empty is removed. Any other lowered budget has no
-- equivalent: the slots and the guard replace it, and its value is named in the NOTICE.
--
-- WHAT IS NAMED. A RAISE NOTICE names every document changed: the project's slug and id, the budget
-- stripped, and whether the steward was turned off. Idempotent: a stripped document holds no budget,
-- so a second run changes nothing.
--
-- ROLLBACK: none in SQL; the NOTICE names each budget, and the key is refused on write.
DO $$
DECLARE
  n integer;
  listed text;
BEGIN
  CREATE TEMP TABLE retired_steward_budget ON COMMIT DROP AS
  SELECT d.project_id, p.slug, d.document -> 'steward' -> 'budget' AS budget,
         coalesce((d.document #>> '{steward,budget,gatewayTurns}')::int, 1) = 0
           AND coalesce((d.document #>> '{steward,budget,runnerJobs}')::int, 1) = 0 AS nothing_ran
    FROM project_config_documents d
    JOIN projects p ON p.id = d.project_id
   WHERE jsonb_typeof(d.document -> 'steward') = 'object' AND d.document -> 'steward' ? 'budget';

  UPDATE project_config_documents d
     SET document = CASE
           WHEN t.nothing_ran
             THEN jsonb_set(d.document #- '{steward,budget}', '{steward,enabled}', 'false'::jsonb)
           WHEN (d.document -> 'steward') - 'budget' = '{}'::jsonb
             THEN d.document - 'steward'
           ELSE d.document #- '{steward,budget}'
         END,
         revision = d.revision + 1,
         updated_by = NULL,
         updated_at = now()
    FROM retired_steward_budget t
   WHERE d.project_id = t.project_id;
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT string_agg(format('%s (%s): steward.budget %s stripped%s', slug, project_id, budget::text,
                           CASE WHEN nothing_ran THEN ', steward.enabled set false' ELSE '' END),
                    '; ' ORDER BY slug)
    INTO listed FROM retired_steward_budget;
  RAISE NOTICE '0664: % project document(s) lost the retired steward.budget: %', n, coalesce(listed, 'none');
END
$$;
