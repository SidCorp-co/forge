-- ISS-895 — delete the staged lane's data, the half no code change can reach.
-- Hand-written data migration (applied from meta/_journal.json), same shape as
-- 0122_drop_shop_skills.
--
-- Three halves, in order:
--
-- 1. The nine staged skill names. 178 `skills` rows (9 global templates + 169
--    per-project clones) and 182 `skill_registrations`, measured on forge-beta
--    2026-09-05. Their directories under `packages/core/skills/` are deleted in
--    the same commit, so `seedBuiltinSkills` — which only upserts, never prunes
--    — can no longer recreate them on boot. `skill_registrations.skill_id` has
--    ON DELETE CASCADE; the registrations are deleted first to be explicit.
--
--    This is the one irreversible half, and its price is paid rather than
--    stated: all 169 forks differ from their template (measured), and no git
--    history holds a fork, so every row is dumped to
--    `.forge/backups/iss895-staged-skills.json.gz` in this same commit. The 9
--    globals are ALSO in git under `packages/core/skills/`; the forks are only
--    there.
--
-- 2. The 4 queued jobs whose TYPE is a staged step, measured on forge-beta
--    2026-09-05 (all `triage`, all under the 5 runs paused on
--    `missing_skill:*`). Removing `missing-skill-resume.ts` empties
--    `MACHINE_RESUMED_PAUSE_KINDS`, so `resumeOrphanedPauses` frees those runs
--    on the first sweep after deploy — and a freed run puts its queued jobs
--    back in front of the picker. `triage` is absent from `RUNNER_CAPABILITIES`
--    now, so every claim would fail `runner_unsupported_type` forever, and
--    `jobs_active_unique` covers `queued`, so the dead row would also block any
--    replacement for the same (issue, type). Cancelling them is what makes the
--    rescue land on a clean queue rather than on four permanent failures.
--
--    The 29,874 TERMINAL staged rows are untouched — a read of one must stay
--    representable, which is why the nine names stay in the `job_type` enum.
--
-- 3. The 16 issues sitting on a staged rung, across 7 projects (measured
--    forge-beta 2026-09-05; the predicate re-parks whatever matches at apply
--    time, not a frozen list). Every one is the wedge ISS-895's own invariant #1
--    predicted: no job dispatches at those statuses, and
--    `AUTONOMOUS_INFLIGHT_STATUSES` — derived from the five driver statuses —
--    cannot see them, so no sweep would ever find them. They are re-parked at
--    `needs_info`, the one park a human's answer restarts, and NOT at `open`:
--    `open` would enqueue an unrequested `drive` job per row at the first
--    reconciler tick.
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

UPDATE "jobs"
SET "status" = 'cancelled',
    "failure_reason" = 'staged_lane_removed',
    "finished_at" = now()
WHERE "status" IN ('queued', 'dispatched', 'held')
  AND "type" IN (
    'triage', 'clarify', 'plan', 'code', 'review',
    'test', 'fix', 'release', 'staging'
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
