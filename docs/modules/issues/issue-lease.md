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

What it does refuse is a key that reaches nothing: a string that is no issue
reference, a prefix that contradicts the `projectId` sent beside it, and a
project the asking box does not reach — named by prefix or by `projectId`.
Reachability is the same union the read uses, bindings **and** leases already
held, so a box unbound while it was working can still give its lease back. A
prefix held out of reach reads the same as a prefix held by nobody, because the
second wording would tell a box about a project it may not ask about.

## The two booleans are two questions

`held` is the fleet-wide fact the pool turns on. `heldByThisDevice` is what a
box's own close loop needs, because a box that never sees its own release land
never marks the run closed. A caller has to say which it is asking.

## What a refusal carries

Holders, not a count: an operator told only that something is held has to open
the database to learn which box to stop. And the sentence differs by who holds —
a box refused by its own earlier run closes that session or waits for the
reaper; one refused by a stranger works something else. One sentence for both
hides which of the two it is.
