# A job admitted to a run a close just ended lands under it

Found while working ISS-1133 round 3, whose consult asked that a job being admitted survive a
cancel's close of its run. That close now takes the run row `FOR UPDATE` first
(`pipeline/runs.ts:closeRunOnceJobsEnd`), so an insert already in flight either commits before the
close reads and keeps the run open, or waits behind the close. What the lock cannot reach is below.

## What is measured

- Both issue-job admission sites pick the run and insert the job in two statements with nothing
  between them: `jobs/routes.ts` (`POST /api/projects/:id/jobs`) and
  `pm/escalation-sweeper.ts`, each `openIssueRun(...)` then `db.insert(jobs)` naming that run's id.
- `openIssueRun` returns the issue's run whose status is `running` or `paused` at the moment it reads.
- Every closer ends a run in its own transaction: `closeRun`, `closeOpenRunForIssue`,
  `closeRunIfOneShot`, `closeRunOnceJobsEnd`, and `runs-concluded.ts:reapConcludedRuns` through
  `closeRun`.
- So a close that commits after `openIssueRun` read the run open and before the insert leaves the new
  job `queued` under a terminal run. With `closeRunOnceJobsEnd` the insert waits on the row lock and
  then commits under the cancelled run; with the closers that cascade, it is cancelled only if it
  committed before the cascade read.

Not walked: what the dispatcher does with a `queued` job whose run is terminal, and whether any
sweep closes that pair afterwards. Not reproduced: no run has been observed taking this path; the
shape is read from the code at `d4439ba`.

## The choice open

Whether admission revalidates the run inside the insert (an `INSERT ... SELECT` that names the run
only while it is open, re-opening a fresh run when it reads none), or whether admission and every
closer share one lock on the issue's run row.

## Honest costs

| Choice | Cost |
|---|---|
| revalidate at insert | two admission sites change, and every new one has to remember it; nothing enforces it |
| one shared lock | every closer and both admissions take the same row lock, which serializes job creation for an issue behind any close of its run |
| leaving it | a job admitted in that window sits live under a terminal run, for a window of one round trip |
