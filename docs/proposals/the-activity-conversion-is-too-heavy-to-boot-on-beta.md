# The activity-history conversion is too heavy to run at boot on beta's volume

**Removed when:** 0344 converts nothing at boot and beta's rows are converted by a batched backfill
or a recorded maintenance-window run, which dev ISS-124 carries. The change that lands it deletes
this file.

**Status:** owed before migration `0344_an_issue_update_records_what_changed` reaches beta. It is
safe on dev, which holds a few hundred `issue.updated` rows.

## The mechanism

0344 rewrites every `issue.updated` row from a per-field snapshot into the changes it made, one
plpgsql pass in the migration transaction. Migrations block server start (`Dockerfile` CMD runs
`dist/db/migrate.js` first), and the image's health check gives the server 30 seconds plus three
10-second retries.

Measured on a throwaway Postgres 16, with synthetic rows shaped like beta's (an 11 KB
`sessionContext` snapshot per row, a lease history that grows and is capped): 10,000 rows took
15.5 s, about 1.5 ms a row. Dev's real 222 rows took 0.1 s.

Beta's volume is estimated, not counted: the 2026-10-03 data-model review sampled 62 forge-dev
issues and found 3,044 `issue.updated` rows (about 49 per issue, with active issues overrepresented).
At 15 to 49 rows per issue across beta's 10,989 issues, that is 165,000 to 540,000 rows, or 4 to 14
minutes inside one transaction, rewriting gigabytes of jsonb. A deploy that slow fails its health
window, and a container killed mid-migration rolls the transaction back and fails the same way on
every retry.

## What is owed

One of two, decided before beta takes 0344:

- **A batched backfill.** 0344 keeps the two functions and converts nothing; a one-shot job converts
  one issue's chain per transaction, so the anchor rule (a field's whole `before` where the previous
  row does not give it) is computed over a whole chain at once. It records `backfill_markers` key
  `activity-field-changes` when done. Until then the activity route converts an unconverted row on
  read with `@forge/contracts/field-changes`, as a priced amnesty that ends when the marker is set.
- **A maintenance window.** Run 0344 by hand against beta with the app stopped, then deploy.

Counting beta's `issue.updated` rows (`SELECT count(*), sum(pg_column_size(payload)) FROM
activity_log WHERE action = 'issue.updated'`) turns the estimate into a number and picks between
them.

## Honest costs

- **The batched backfill keeps two readings of one row alive.** Until the marker is set, the activity
  route converts on read, so a reader outside that route sees the old snapshot shape.
- **The maintenance window takes beta down.** Every project on beta is unreachable for the minutes the
  conversion runs, and the app has to be stopped by hand before it starts.
- **Either choice costs a count on beta first.** The estimate above is from a 62-issue sample, and
  picking without the number risks the failure this page describes.
