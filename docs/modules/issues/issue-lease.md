# The issue lease

`packages/core/src/issues/issue-lease.ts` is the only writer of `issue_leases`
and the only place the SQL for *"is this issue being worked"* is written.

## Why a row and not a jsonb array

Held-ness was derived from `pipeline_runs.metadata -> 'runIssues'`. No index
constrains an element of a jsonb array, so nothing could refuse a second taker
and two boxes could hold one issue at once. The primary key on
`issue_leases (project_id, issue_key)` is what refuses it. `runIssues` remains
the run's membership record and says nothing about who holds what.

## Held-ness is the row AND a live session

A lease row alone is not held-ness: the row outlives the box, and a lease
nothing can release strands the issue where no run can take it. So held-ness is
the row **and** a session that has not reached a terminal status.

Terminal is monotone — a terminal session never becomes live again. That is the
whole safety argument for the reaping half of `takeIssueLeases`: a reap that
takes only rows whose session is already terminal can never take a lease from a
run that is still working.

## Why the take is per key, in sorted key order

`takeIssueLeases` reaps and inserts **one key at a time**, in sorted order.

Sorting a whole-group `DELETE` and a whole-group `INSERT` is not enough. The
reap locks only rows whose session is terminal, and *which rows those are*
differs between two openers when a session turns terminal between their two
reaps. One opener can then hold a higher key while waiting on a lower one.
Postgres answers that with a deadlock abort (SQLSTATE `40P01`) instead of the
named refusal this module exists to deliver.

The take is all-or-none and runs inside the transaction that inserts the run and
the session, so a refusal rolls those back with it. A partial open — some issues
leased, the rest silently joined — is the state this prevents, not a smaller
version of it.

## What identifies a release, and what only narrows it

`(project_id, issue_key)` identifies the row, on the give-back exactly as on the
take. `iss_seq` restarts per project, so `ISS-880` is a different issue in every
project a box serves and one box can hold several rows under that one key. A
delete keyed on the device alone matches all of them, which is a different
question with a different answer set: it gave back one issue and freed two
(ISS-1139).

`device_id` stays in the `WHERE` of both statements, and it is the check that a
box releases only its own — a box that could release another box's lease could
take an issue out from under a running agent, the same defect this module closes
arriving from the other side. It is not what says which row.

So `releaseIssueLeaseRow` settles the identity before it removes anything: it
reads the candidate rows `FOR UPDATE`, and answers `not_held` for none and
`ambiguous` for more than one rather than picking. The route turns those into a
`404` and a `409`, because a delete that matched nothing acknowledged as `200`
is read by the box as the issue handed back.

The `409` is the one answer a box cannot settle from the key alone: core holds
two rows and nothing in the request chooses between them, so the way out is
`?projectId=`, which a runner sends off the ledger's `runs.project_id`. A box
whose runner predates that parameter meets the refusal and keeps meeting it
until it is upgraded, which is this change's one deploy coupling. Its close loop
writes what core said to its own log rather than discarding it: a run that will
not close is legible only while the sentence naming the way out survives.

`releaseIssueLease` takes an executor rather than reaching for `db`, because the
lease and the run's membership have to drop in one transaction. Between two
autonomous writes, a replacement open on the same device can take the lease back
and then have its membership stripped by the second half of the earlier release.
The membership `UPDATE` is narrowed to the project whose row went, for the same
reason the delete is.

## One vocabulary in the store, two on the wire

The pool hands a box `formatIssueRef(issue_prefix, iss_seq)` — `FD-880` on a
project with a prefix — while the store keeps `canonicalIssueKey(issSeq)`,
`ISS-880` (ISS-992). That is the interface's own second vocabulary and not a
caller's mistake, so `resolveLeaseKey` maps it rather than refusing it, and
every lease endpoint goes through that one function. It returns the canonical
key and the project the prefix named, which is also how a caller identifies one
of several rows without a query parameter.

What it does refuse is a key that reaches nothing at all: a string that is no
issue reference, a prefix no project anywhere answers to, and a prefix that
contradicts the `projectId` sent beside it. All three are properties of the key,
and none of them changes when a lease does.

Two of those three say more than that they hold: no lease can stand under that
key at all. A string that is no issue reference names nothing the store keys a
row by, and a prefix no project answers to covers the tombstone a deleted
project leaves — `issuePrefixAliases.projectId` is `set null` and the row stays
spent, while the cascade on `issueLeases.projectId` has already taken every
lease that project held. Nothing a box does refills the prefix. So the runner's
`lease_state` reads those two codes as `held: false` and logs which one it met,
while `ISSUE_LEASE_KEY_PROJECT_MISMATCH` stays an error: there the request names
two identities that disagree, a lease may stand under either, and `held: false`
would mark a standing lease returned. The match is on the code and never on the
status, because a bare `404` from a core that does not serve the route says
nothing about any lease.

A project the asking box cannot reach is **answered, not refused** — `held:
false`, which is true, and which the `reachableProjects` filter already
produced. Refusing it was tried and reverted: reachability is bindings *union
leases already held*, so an unbound box releasing its last lease would destroy
its own permission to read that release back, and the close loop — which marks a
run closed only on a successful read — would never terminate. A refusal whose
condition the successful operation creates is not a loud failure; it is a wedge.

## The two booleans are two questions

`held` is the fleet-wide fact the pool turns on. `heldByThisDevice` is what a
box's own close loop needs, because a box that never sees its own release land
never marks the run closed. A caller has to say which it is asking.

## Two questions about work on an issue

`issueWorkInFlightSql` asks whether anything is owed on the issue: any
non-terminal job, including one `held` for a person, and a `paused` run count.
The strand pass reads it, because a row carrying either does not need escalating.
`issueWorkMovingSql` asks whether a box is moving the issue now: only
`UNHELD_LIVE_JOB_STATUSES` jobs and a `running` run count. The board's `held` reads
it (ISS-1213), because a row whose only job waits on a person is not Running.
Both count a held lease. A run the runner declared is held through the lease
`openRunSession` takes; a run nobody declared has only its claim, so the board
shows a row nothing holds as No check-in, with `lastCheckInAt` from the same
hydrator, rather than claiming it stalled.

## What a refusal carries

Holders, not a count: an operator told only that something is held has to open
the database to learn which box to stop. And the sentence differs by who holds —
a box refused by its own earlier run closes that session or waits for the
reaper; one refused by a stranger works something else. One sentence for both
hides which of the two it is.
