-- ISS-1229 — the nine staged-pipeline job types leave `jobTypes`, and their historical rows leave
-- `jobs`. `jobs.type` is plain text with no CHECK, so the vocabulary narrows in code and this
-- migration is data only.
--
-- WHAT GOES: every `jobs` row whose type is triage, clarify, plan, code, review, test, staging,
-- release or fix, and with it (FK cascade) its `job_events`. Old data is dropped, not carried: no
-- door can mint these types, and the code that read them is gone with this change.
--
-- WHAT LOSES ITS LINK AND STAYS: `usage_records.job_id` has no foreign key, so this nulls the ones
-- that named a deleted job and keeps the spend; `phase_journal.job_id`, `feedback_reports.job_id`
-- and `jobs.retry_of` are nulled by their own `ON DELETE SET NULL`. Every `pipeline_runs` row stays.
--
-- THE GUARD aborts naming the job, and never cancels a row away so the delete succeeds: a job of a
-- retired type still `queued`, `dispatched`, `running` or `held` is work somebody is waiting on.
--
-- The deletion is this migration's own record, so it stamps the kernel marker: without it the
-- deletion detector files one unaudited-transition row per job this migration names in its NOTICE.
DO $$
DECLARE
  bad record;
  retired uuid[];
  n_jobs int;
  n_events int;
  n_usage int;
  n_journal int;
  n_feedback int;
BEGIN
  -- Held to commit: a job written while this runs is either seen by the guard or written after it.
  LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;

  SELECT id, type, status INTO bad FROM jobs
    WHERE type IN ('triage', 'clarify', 'plan', 'code', 'review', 'test', 'staging', 'release', 'fix')
      AND status IN ('queued', 'dispatched', 'running', 'held')
    ORDER BY queued_at, id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1229: job % of the retired staged type % is still %. Nothing was changed; let it finish or cancel it, then deploy again.',
      bad.id, bad.type, bad.status;
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO retired FROM jobs
    WHERE type IN ('triage', 'clarify', 'plan', 'code', 'review', 'test', 'staging', 'release', 'fix');

  n_jobs := cardinality(retired);
  SELECT count(*) INTO n_events FROM job_events WHERE job_id = ANY (retired);
  SELECT count(*) INTO n_journal FROM phase_journal WHERE job_id = ANY (retired);
  SELECT count(*) INTO n_feedback FROM feedback_reports WHERE job_id = ANY (retired);

  UPDATE usage_records SET job_id = NULL WHERE job_id = ANY (retired);
  GET DIAGNOSTICS n_usage = ROW_COUNT;

  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  DELETE FROM jobs WHERE id = ANY (retired);

  RAISE NOTICE 'ISS-1229: deleted % jobs of the nine retired staged types with their % job events; unlinked % usage records, % phase journal entries and % feedback reports that named them, each kept',
    n_jobs, n_events, n_usage, n_journal, n_feedback;
END $$;
