# A strand is derived per row and cannot be read in bulk

`pipeline/idle-issues.ts` writes a `strand` record onto every row it finds standing with nothing
behind it: the status, how long it has stood there, what it waits for, who owes the next move, and
the reason drawn from the evidence by `pipeline/strand-rules.ts:strandReason`. The derivation is
good and it runs on the sweeper tick for every project.

It is written to `issues.session_context`, which the browse query does not read. `issues/list-service.ts`
projects the light columns deliberately — ISS-562 kept `description`, `plan`, `acceptanceCriteria`,
`sessionContext` and `releaseNotes` off the read so a browse over a populated project does not pull
their TOAST pages. So a strand appears on the single-issue route and nowhere else: reading the
strand of n rows costs n requests, and the list route it would naturally be read from is per project
rather than fleet-wide.

## What that cost, measured

ISS-1195's first comment counted every unfinished row on nine projects on this box, bucketed by how
long since it last moved. 1,210 rows had stood still for over twelve hours waiting on something that
was not a person; 797 of them for over three days. The reason for each was already computed and
already on the row. Nothing could read them together.

The same comment recorded the half no per-row field expresses: a rung filling faster than it drains.
Twelve `sid-desk` rows sat at `testing`, every one judged and passed, each one short of a single
verification record, and not one of them was twelve hours old. An age threshold at any value reports
that project clean, because rows arrived faster than the threshold could age them. What was wrong was
the ratio — twelve at one rung, two past it, in a day — and a row cannot see it, because every
individual row looks recent and healthy.

## The residual, and why it is not taken here

ISS-1195 shipped the condition its sweep could not see: a lease inside its own term whose holder has
stopped reporting now reads `abandoned`, is released, and says so on the row. That is the mechanism
the issue named, and it is the whole of what that issue's approved direction asked for.

The reader is a different mechanism and a larger one. It is at least a choice about the list
projection ISS-562 made on purpose, a fleet-wide route where every route here is project-scoped,
and — for the ratio half — a per-rung aggregate that nothing currently computes. None of those is a
line this change could have carried, and a strand column bolted onto the browse read would undo a
measured decision without measuring anything in its place.

So it is written here rather than built: whoever takes it starts from what is already derived, and
from the two signals the measurement above says are needed — a row that has not moved, which
`strand.since` already gives, and a rung filling faster than it drains, which nothing does.

## Honest costs

- **Whoever adopts this pays for the TOAST pages ISS-562 stopped paying for.** Putting `strand` on
  the browse row reads a `jsonb` column off disk for every issue listed, on a route people hit
  repeatedly, to serve a question they ask occasionally.
- **A fleet-wide route is a new authorization surface, not a wider filter.** Every issue route here
  is project-scoped and answers to a role on that project; one question spanning projects has to
  decide what a person may see across the ones they do not hold a role on, and get that right.
- **The ratio signal costs a stored series.** Twelve rows arriving at one rung in a day cannot be
  read off the rows; something has to remember what the rung held yesterday, which is a table, a
  retention decision and a backfill nobody has budgeted.
- **Waiting costs the rows this document counted.** Deferring it leaves 1,210 measured rows idle
  over twelve hours with their reason already computed and unreadable in bulk, and that number grows
  with the fleet rather than with the backlog.
