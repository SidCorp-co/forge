-- ISS-1255: a steward run waits for a run slot, never for a day (criterion 1). Before this change the
-- daily budget deferred a run it could not pay for to the next UTC day, and 0664 stripped the budget
-- from project documents only: the runs it had already deferred stayed queued behind that day, and
-- `runs-store.ts:claimDueRuns` takes only `not_before <= now`. Judged live on dev.694: ISS-1254's
-- release follow-through, queued 07:48Z, still waited at 08:53Z for 2026-11-17T00:00Z with its
-- project's slot free.
--
-- WHICH RUNS. The budget's own stamp is `steward/policy.ts:nextUtcDay(now)` before this release:
-- `Date.UTC(y, m, d)` of the UTC day plus 86 400 000 ms, so exactly a UTC midnight to the
-- millisecond, and never more than a day ahead of when it was written. It reached `not_before` by
-- three writers, every one a queued run with no job: `dispatch.ts` deferring a claimed run
-- (`deferSweepRun`), `dispatch.ts` carrying a run's runner acts to its follow-up
-- (`endRun`'s `followUpNotBefore`), and `owed-checks.ts:raiseOwedChecks` queueing a check past the
-- day's room (`dueAt`). This releases exactly those: `queued`, `job_id` NULL, `not_before` still
-- ahead, at most a day ahead, and on a UTC midnight. A debounce (`at` + the debounce) or a slot retry
-- (`Date.now()` + the retry) lands on a midnight only by a sub-millisecond chance, so they are left.
--
-- WHAT CHANGES. Each such run's `not_before` becomes now(): it is due, and waits only for its
-- project's slot (`devices/run-slots.ts:slotsFor`).
--
-- WHAT IS NAMED. A RAISE NOTICE names every run released: its id, its project's slug, its subject
-- and the day it waited for. Idempotent: a released run is due now, never ahead, so a second run
-- changes nothing.
--
-- ROLLBACK: none in SQL; the NOTICE names each run and the not_before it held.
DO $$
DECLARE
  n integer;
  listed text;
BEGIN
  CREATE TEMP TABLE budget_deferred_runs ON COMMIT DROP AS
  SELECT r.id, p.slug, r.subject_kind, r.subject_key, r.not_before AS old_not_before
    FROM steward_runs r
    JOIN projects p ON p.id = r.project_id
   WHERE r.state = 'queued'
     AND r.job_id IS NULL
     AND r.not_before > now()
     AND r.not_before <= now() + interval '1 day'
     AND (r.not_before AT TIME ZONE 'UTC') = date_trunc('day', r.not_before AT TIME ZONE 'UTC');

  UPDATE steward_runs r
     SET not_before = now()
    FROM budget_deferred_runs t
   WHERE r.id = t.id AND r.state = 'queued';
  GET DIAGNOSTICS n = ROW_COUNT;

  SELECT string_agg(format('%s (%s %s %s): was due %s', id, slug, subject_kind, subject_key,
                           to_char(old_not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
                    '; ' ORDER BY slug, subject_key)
    INTO listed FROM budget_deferred_runs;
  RAISE NOTICE '0665: % steward run(s) the retired budget deferred are due now: %', n, coalesce(listed, 'none');
END
$$;
