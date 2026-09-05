-- ISS-895 — delete the staged lane's data, the half no code change can reach.
-- Hand-written data migration (applied from meta/_journal.json), same shape as
-- 0122_drop_shop_skills.
--
-- Two halves, in order:
--
-- 1. The nine staged skill names. 178 `skills` rows (9 global templates + 169
--    per-project clones) and 182 `skill_registrations`, measured on forge-beta
--    2026-09-05. Their directories under `packages/core/skills/` are deleted in
--    the same commit, so `seedBuiltinSkills` — which only upserts, never prunes
--    — can no longer recreate them on boot. `skill_registrations.skill_id` has
--    ON DELETE CASCADE; the registrations are deleted first to be explicit.
--
-- 2. The 16 issues sitting on a staged rung. Every one of them is the wedge
--    ISS-895's own invariant #1 predicted: no job dispatches at those statuses,
--    and `AUTONOMOUS_INFLIGHT_STATUSES` — derived from the five driver statuses
--    — cannot see them, so no sweep would ever find them. They are re-parked at
--    `needs_info`, the one park a human's answer restarts, and NOT at `open`:
--    `open` would enqueue 16 unrequested `drive` jobs across 10 projects at the
--    first reconciler tick.
--
--    The prior status is written to `issues.metadata->'iss895'`, so this is
--    reversible by one UPDATE per row rather than by guesswork.
--
-- `released` is deliberately NOT in the list. Its 79 rows across 13 projects are
-- the release-batch park on projects whose production branch differs from their
-- base — a live status in this lane, not a staged rung.

DELETE FROM "skill_registrations"
WHERE "skill_id" IN (
  SELECT "id" FROM "skills"
  WHERE "name" IN (
    'forge-triage', 'forge-clarify', 'forge-plan', 'forge-code', 'forge-review',
    'forge-test', 'forge-fix', 'forge-release', 'forge-staging'
  )
);

DELETE FROM "skills"
WHERE "name" IN (
  'forge-triage', 'forge-clarify', 'forge-plan', 'forge-code', 'forge-review',
  'forge-test', 'forge-fix', 'forge-release', 'forge-staging'
);

UPDATE "issues"
SET "metadata" = coalesce("metadata", '{}'::jsonb)
                 || jsonb_build_object('iss895', jsonb_build_object(
                      'priorStatus', "status",
                      'reparkedAt', now()
                    )),
    "status" = 'needs_info',
    "updated_at" = now()
WHERE "status" IN (
  'confirmed', 'clarified', 'approved', 'developed', 'testing', 'tested', 'reopen'
);
