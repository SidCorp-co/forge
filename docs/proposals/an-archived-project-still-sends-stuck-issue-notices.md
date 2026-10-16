# An archived project still sends stuck-issue notices

Archiving a project takes it out of the default list and out of automatic dispatch
(`packages/core/src/projects/routes-reference.ts`, the archive route's description), and it does
not require its issues to be closed or dropped first. The three sweeps that tell a project's admins
about a stuck issue read every project, archived or not: the orphan-assertion sweep
(`packages/core/src/pipeline/issue-run-invariant.ts:detectOrphanedRunAssertions`, which joins
`projects` and never reads `archived_at`), the idle-issue sweep (`idle-issues.ts`) and the
waiting-park sweep (`stranded-issues.ts`).

## What was seen

Judge-22's scratch project `qa-j22o` on beta was archived at 2026-10-16T11:26Z with its ISS-1 at
In progress and no run behind it, and the master that dispatched ISS-1229 r10 reported the orphan
notice for ISS-1 still reaching the Org Owner test user's inbox after that. ISS-1229 r10 dropped and archived ISS-1 to ISS-4 by hand (13:45Z). The same
read found four more archived scratch projects holding live issues, each a notice source once its
grace ends: `qa-judge5-scratch` (ISS-21 In progress, others Open, On hold, Reopened),
`qa-judge5-b`, `qa-judge5-c` (On hold) and `qa-iss1317-w12c` (Open). They were left as they are,
since they belong to other issues' judges.

## The decision owed

Either is a small change; which is right is the owner's:

- **The sweeps skip an archived project**, and resolve the episodes already open on one. An
  archived project is put away, and a notice about it can only be answered by unarchiving it.
- **Archiving a project with live issues is refused, naming them**, as archiving an issue that is
  not Closed or Dropped already is (`ARCHIVE_REFUSED`). Then no archived project can hold an issue
  that says work is in progress, and the sweeps need no exception.

Until one is taken, a judge or a person who archives a scratch project drops its live issues first.
