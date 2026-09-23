# Closes that predate the shipped rule

**ISS-1108, 2026-09-23. A priced amnesty, and the residual it leaves.**

`closed` means the work shipped. `issues/merged-at.ts:refuseUnshippedClose` holds that in the
application and `trg_issues_closed_means_shipped` holds it in the database, against whatever wrote
the row.

Neither reaches backwards. On forge-beta, **597 issue rows read `closed` with no `merged_at`** —
the oldest `ISS-1` of another project. Migration `0304_closed_means_shipped` originally refused to
run while any existed, on the stated premise that the close had been stamping since `0185` and the
only route into the state was an `unmark` after a close, so the count would be small. The premise
was wrong: closes predating the stamping are a population, not an accident. Because the container
runs `dist/db/migrate.js` before the server in one command, that refusal took the API down rather
than stopping a bad write.

## What was traded

Those 597 rows keep a state the forward rule forbids. They read `closed` while carrying nothing
that shows the work shipped, so any reader that takes `closed` as a delivery claim is wrong about
them, and `mergeMarkKindOf` reads every one of them as `unmarked`.

## Honest costs

Two things, and only two:

- A count, not a decision. The migration names the population in a `NOTICE` at every deploy, so
  the number is on the record rather than in one agent's transcript.
- The trigger governs the **transition** and not the state — `NEW.status = 'closed' AND
  NEW.merged_at IS NULL AND (OLD.status IS DISTINCT FROM 'closed' OR OLD.merged_at IS NOT NULL)`.
  A row already standing there stays writable; nothing can newly enter the state, on UPDATE or on
  INSERT, and clearing the claim from under a row that stands `closed` is still refused.

What was **not** traded: no row was stamped `merged_at`, moved to `dropped`, or deleted. Each of
those fabricates a status for 597 pieces of work nobody decided, which is what
`VISION: state-never-lies` forbids and what the original guard was right to refuse. The guard was
wrong about what to do with the answer, never about asking.

## The condition that ends it

Per project, by whoever owns the rows: mark the merge where the work landed, or move it to
`dropped` where it did not. The amnesty ends for a project when its count reaches zero, and ends
outright when the `NOTICE` reads `0 closed row(s) without merged_at`. Nothing here is scheduled and
nothing ages it, deliberately — a sweep that decided 597 rows on a rule would be the fabrication
this file exists to refuse.

## Evidence traded for restoration speed

Proved against a real Postgres on the pre-`0304` schema with planted legacy rows: the migration
completes, the rows are unchanged and writable, and entry into `closed` without a claim is still
refused by name on UPDATE and on INSERT. Two things were **not** done, at the owner's explicit
instruction during the outage: the red-first reproduction of the un-updatable legacy row, and the
local `@forge/core` integration suite — CI runs the latter. The condition that ends that trade is
the judging run, which re-judges all nine of ISS-1108's criteria at the merged commit.
