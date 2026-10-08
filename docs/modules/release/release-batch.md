# A release batch, from the press to the close

A release batch is one `pipeline_runs` row that claims a roster of issues, hands one
`release_batch` job to a box, and closes the roster when that job reports what it shipped. These
are the hops it takes and what each one says when it cannot go on. The code is in
`packages/core/src/release-batch/`; every refusal's sentence, remedy and cost is in
`packages/core/src/release-batch/blocker-sentences.ts`.

## 1. The press: the create door

`POST /api/projects/:projectId/release-batches` (`packages/core/src/release-batch/routes.ts:releaseBatchRoutes`) calls
`packages/core/src/release-batch/service.ts:createReleaseBatch`. Before it claims anything, `packages/core/src/release-batch/blockers.ts:collectReleaseBlockers`
judges the whole batch and reports every reason at once, not the first. The enumerator reaches no
network: its caller reads what lives elsewhere and passes the reading in.

### What the release carries beyond its roster (ISS-1386)

On a chain that promotes by `merge-branch`, everything between the live branch and the start branch
reaches production, named or not. So the create reads that range first:

- `packages/core/src/release-batch/cut-range.ts:readRangeTo` pins the start branch's head — that commit is the **cut** — and reads
  every commit the cut holds that the live branch does not, from the project's repository: through its
  GitHub binding (`compare(live...cut)`, every page of it), or, where the project has no binding, with
  git as the deploy key attached to it (ISS-1398; the route is
  `packages/core/src/projects/repository-access.ts:withRepository`'s, below).
- `packages/core/src/release-batch/carried.ts:readCarried` names every issue of the project whose landing commit is in the range and
  that is not on the roster, whatever its status: a `needs_info` issue, one being judged, or one
  closed while its landing never reached the live branch.
- `packages/core/src/release-batch/carried.ts:judgeCarried` requires a decision for each, sent in the create body's `carried`:
  - `ship-unverified` with `why`: what is unverified. It goes on the run's `metadata.carried`, and
    `packages/core/src/release-batch/carried.ts:noteShipUnverified` writes a comment on the issue naming the release version, the
    run, the person who decided (their display name, else their email) and the reason.
  - `revert`: holds only where the range holds an effective revert of the landing — a commit whose
    message says `This reverts commit <landing>` that no later commit reverts in turn. Where the
    revert was itself reverted, the refusal names both commits and offers reverting the landing
    again, `ship-unverified` or `cut-below`; only where no revert exists does it say to revert first.
  - `cut-below`: moves the cut to the first parent of the earliest such landing and reads the range
    again to that cut. It is refused where a roster member's landing would fall above the new cut.

Each outcome has its own code:

| reading | answer |
|---|---|
| an issue in the range holds no decision | `RELEASE_CARRIES_UNDECIDED` (409), each issue named with its status and the ways out |
| a decision that does not hold | `RELEASE_CARRIED_DECISION_REFUSED` (409), the issue and why |
| a cut-below that drops a roster member | `RELEASE_CUT_DROPS_ROSTER` (409), each member it drops |
| the repository fails to answer, on either route | `RELEASE_CHECK_UNEVALUATED` with check `carried` (503), its message naming the read's own reason |
| the project has neither a GitHub binding nor a deploy key | not refused: warning `RELEASE_CARRIED_UNREAD`, naming what to attach under Git access, and the GitHub binding only for a github.com remote |
| a publish chain or a cherry-pick crossing | not refused: `carried.kind` is `not-read` with its reason |

Each carried issue is named with its display id, title and status. The create answer carries
`carried` (the cut and each issue with its decision) and the warnings. The release job's prompt
(`packages/core/src/release-batch/prompt.ts`) tells the agent the exact cut to promote, not the
branch head. The release screen's readiness
(`packages/core/src/release-batch/readiness.ts:loadReleaseReadiness`) runs the same check before
anyone presses and answers the same `carried` reading, so a range that was not read says so there
with its reason. The batch release dialog
(`packages/web-v2/src/features/issues/components/batch-release-dialog.tsx`) lists each carried
issue by its title with Ship unverified (a reason is required), Reverted or Cut below, each choice
explained before it is picked, and sends the decisions when release is pressed again. A refusal is
said directly above the Release button, and a decision the server refused is marked on its own row
with why. Once the
batch opens, its notice names the cut and each warning the create answered with. A create takes a
decision for as many issues as the range can hold commits, which is more than a roster may name.

A refused create claims no issue and leaves no open run.

### What the finish could not close, said before the press (ISS-1337)

The batch closes its roster only at the finish, so a roster issue whose close would be refused
used to be claimed, released and handed back to the gate, said only afterwards.
`packages/core/src/release-batch/close-shortfall.ts:rosterCloseShortfalls` reads, for each issue,
the refusals that close would make, by calling the close's own predicates:

| the close would refuse | because | reported as |
|---|---|---|
| `CLOSE_REQUIRES_SHIPPED` | no mark, or outside git no mark naming a landing (`packages/core/src/issues/merged-at.ts:refuseUnshippedClose`) | `RELEASE_WORK_UNMERGED`, worded for the issue's shape |
| `OPEN_QUESTIONS` | an open question on the issue | `RELEASE_ISSUES_UNCLOSABLE` |
| `ENTRY_CRITERIA_UNMET` | a record the project declares for `closed` is missing (`packages/core/src/issues/transition-evidence.ts:checkTransitionEvidence`) | `RELEASE_ISSUES_UNCLOSABLE` |

Both are 409 blockers at the create door and at the release-record door alike, each naming the
issue, its reason and what clears it; a refused create claims nothing and opens no run. Readiness
reads the same enumerator, so it lists them before anyone presses. The roster answer carries each
issue's `closeRefusals` (`code`, `reason`, `clears`), and the release gate panel and the issue's
awaiting-release banner offer no release for such an issue and print why. The unattended sweep
leaves such an issue off its cut and writes a `RELEASE_ISSUES_UNCLOSABLE` release hold on it; a
scheduled cut leaves it off and names it in its outcome. A refusal that arises after the press, a
question asked mid-run, is still met at the finish below.

On a project whose deploy is a person's, the finish does close every issue whose close stands. With
no verify probe it is recorded unverified, written on each issue as whoever finished the release
(`packages/core/src/release-batch/unverified-close.ts:noteUnverifiedCloses`), and claims no deploy.

### A roster over the cap (ISS-1360)

One release names at most 50 issues (`packages/core/src/release-batch/blocker-sentences.ts:RELEASE_ROSTER_LIMIT`).
What a project does with more than that depends on who cuts its releases:

| the project | readiness over the whole roster |
|---|---|
| releases without a person acting (`autoProdDeploy`) | no block: the warning `RELEASE_ROSTER_IN_PARTS` names the waiting count, the 50 in this part and how many are left; every check (note, close, carried range, criteria) judges that part alone |
| a person cuts the release | `RELEASE_ROSTER_OVERSIZE` (409), its remedy telling a person to cut in parts |
| a caller names more than 50 ids | `RELEASE_ROSTER_OVERSIZE` (409), on either kind of project |

The part is the oldest 50 merges among the rows no batch has claimed, an issue with no merge mark last
(`packages/core/src/release-batch/waiting-order.ts:oldestMergeFirst`), which is the order the sweep
cuts in (`packages/core/src/schedules/release-batch-run.ts:cutWaitingRelease`). The sweep first sets
aside a row it is holding back, so a held row inside the part lets a later one into the cut; readiness
judges the oldest 50 as they stand. The rows behind the cut carry `RELEASE_QUEUED_BEHIND` and go in the
next automatic release once the running one has finished. Whether a project releases without a person
is read by `packages/core/src/pipeline/auto-prod-deploy.ts:readAutoProdDeploy`, and a read that fails
is `RELEASE_CHECK_UNEVALUATED` beside the size refusal, never taken for a project where a person cuts. On a chain that promotes by merging a branch, a part's range still carries the landings of
the rows behind it, and the carried check above answers those as it answers any unnamed landing.

## 2. From the claim to a box: the start (ISS-1323)

A create that passes moves the roster to `releasing` and enqueues one `release_batch` job.
`packages/core/src/release-batch/job-start.ts:readReleaseStart` reads that job, and `GET
/api/projects/:projectId/release-batches/:runId/state` returns it as `start`. A batch no box has
started can therefore be told apart from one whose agent is working:

| job row | `start.kind` |
|---|---|
| dispatched (any status) | `taken`, with when and on which device |
| queued, nobody holds it | `waiting`, with when it was queued, when it is handed back, and a reason: `no-eligible-box` (each box and what holds it), `no-box`, or `eligible-not-taken` (the eligible boxes, named) |
| queued, a box holds the claim | `claimed`, held but not started |
| cancelled by the unstarted deadline | `handed-back`, with that deadline's own reason |
| never dispatched, under a run a person aborted | `aborted`, with when, who (their display name, else their email) and the reason they gave, read off the run's abort stamp |
| any other end, never dispatched | `ended`, with the job's error |
| no release job under the run | `none` |

`packages/core/src/release-batch/unstarted-recovery.ts:recoverUnstartedReleaseBatches` hands back a batch still `waiting` after
`packages/core/src/release-batch/job-start.ts:RELEASE_UNSTARTED_DEADLINE_MS`. It finds those batches with the same predicate,
`packages/core/src/release-batch/job-start.ts:unpickedJobSql`, so the reading and the hand-back cannot disagree about which batch
is unstarted. Each reading's `why` is written for the person who pressed: no runner term, and no
timestamp inside the sentence — the screen prints the times itself.

The run screen (`packages/web-v2/src/features/releases/components/release-run-screen.tsx`) prints
`waiting` and `claimed` as "No box has started this release", `handed-back` as "Handed back to the
release gate", `aborted` as "Aborted before it started" with who, when and why, `ended` as "This
release never started", and `none` as "This run holds no release job", each with the reading's own
why, its code spans shown as code and its times in the reader's local time with how long ago or
until. It prints nothing for `taken`. Where the release never started, its Method section says no
method was announced for that reason. Its Roster lists the issues the run was opened with
(`runIssues`, read off the run's `metadata.issueIds` by
`packages/core/src/release-batch/queries.ts:loadRunIssues`), each as it stands now, not the
release gate. The screen is flat: sections under hairlines, no cards. On the release gate, a
claimed issue reads "in a release", not "shipping now".

## 3. The finish

The job reports through `forge_release_batch` `finish` (or the REST `finish` route).
`packages/core/src/release-batch/finish-job.ts:acceptReleaseBatchFinish` records it and queues it, and
`packages/core/src/release-batch/finish-job.ts:runReleaseBatchFinish` runs `packages/core/src/release-batch/service.ts:finishReleaseBatch`, which closes each issue
on the roster. `packages/core/src/release-batch/finish-precondition.ts:assertFinishable` decides whether a run can be finished at
all.

### The agent says when to look; Forge takes the reading (ISS-1282)

A finish does not read the site and does not wait. The agent calls `look` (`forge_release_batch`
`look`, or `POST /api/projects/:projectId/release-batches/:runId/readings`) once its deploy is made.
`packages/core/src/release-batch/look.ts:lookAtBatch` has Forge read every live deploy binding that
declares a probe (`packages/core/src/release-batch/verify.ts:readLiveState`) and keeps one row in
`release_readings` (`packages/core/src/release-batch/readings.ts:takeReading`): what each binding's
probes said, who asked, and the bindings that declare none, named `unread`. The row is
append-only and goes with its run. The answer carries what a finish would make of the readings so
far, so the agent decides whether to look again.

`finish` closes a probed roster on those rows and on nothing the agent says.
`packages/core/src/release-batch/reading-judge.ts:judgeReadings` judges each probed binding on its
newest `stableReads` readings (two where the binding declares none): every one healthy, all of them
agreeing on one identity, and that identity the claimed commit or, with none claimed, a build other
than the one the binding served when the batch opened
(`packages/core/src/release-batch/verify.ts:readingSatisfies`; the build before is
`metadata.commitBeforeBy`, by binding id). The newest reading must be younger than
`packages/core/src/release-batch/reading-judge.ts:RELEASE_READING_MAX_AGE_MS`, a bound on the age of
evidence and not on a wait. Each reading carries the probes it was taken with
(`packages/core/src/release-batch/verify.ts:probesKeyOf`), and a reading taken with probes the
binding no longer declares ends the run of readings a close may rest on. Every binding must pass; the refusal names each one that does not. A
healthy site still serving the old build stays red. The door
(`packages/core/src/release-batch/finish-job.ts:acceptReleaseBatchFinish`) judges the stored readings
inline, which makes no request, and answers `RELEASE_NOT_VERIFIED` at once where they do not
confirm; the worker judges them again and stamps the reading ids it rested on, `evidence`, on the
finish record. A readings set that has gone red between the two ends the attempt `failed`.

What bounds an agent that never looks: nothing closes. Its finish is refused saying no reading is
recorded, the roster stays `releasing`, and the run's `state` lists the readings it holds
(`readings.total`, and the newest ten). The release job's own `timeoutSeconds: 3600` ends the run,
and `packages/core/src/release-batch/claim-subscriber.ts` hands an unworked roster back. A project
whose live bindings declare no probe has nothing to read: `look` is refused with
`RELEASE_NOTHING_TO_READ`, and its finish records the release unverified, with a note on each issue.
Where only some bindings declare a probe, the rest are `unread` and each closed issue is noted as
verified at only some of its deploy bindings. `verify.timeoutSeconds` is refused by name on a
binding. The single-moment read of `POST /release-records`
(`packages/core/src/release-batch/verify.ts:verifyServingNow`) is unchanged, now run once per
binding.

### A close that is refused (ISS-1381)

One issue's refused close does not stop the others from closing. The refused issue goes back to
`awaiting_release` through `packages/core/src/release-batch/releasing-recovery.ts:recoverStrandedReleasing`, and the comment it
leaves (`packages/core/src/release-batch/releasing-recovery.ts:refusedCloseComment`) says:

- that the release it was in has shipped, with its version;
- the refusal by its code (`OPEN_QUESTIONS`, say), and every blocking object the refusal reports —
  each id under a `*Ids` key of its details, labelled (`open question <id>`);
- what clears it, as an act the issue's page offers at the release gate — for `OPEN_QUESTIONS`,
  answer each in its "Decision waiting" card; for `CLOSE_REQUIRES_SHIPPED`, Mark merged on its
  Properties rail; a code with no such act keeps the refusal's own detail
  (`packages/core/src/release-batch/releasing-recovery.ts:personClears`);
- how it closes once cleared: the issue page's release banner offers Release now, which starts a
  release that closes it, or it waits at Awaiting release for the next release. It names no move
  to Closed — the status menu draws `packages/core/src/pipeline/state-machine.ts:transitions`, whose
  `awaiting_release` row holds none — no withdrawal of a question, which no surface there offers,
  and no API route (`docs/proposals/a-shipped-issue-at-the-gate-closes-only-by-another-release.md`).

Where the run recorded a `promote` attempt, the refused issue does not move: it stays at
`releasing`, still claimed, because the code may be on production. Its comment names the same
refusal, and in place of the last point it says that settling a promoted roster is an operator's
act no screen offers yet — abort the batch with `promotedRoster: return-to-gate`, or settle the
issue by hand (`docs/proposals/a-promoted-roster-is-settled-only-through-the-api.md`).

A close that failed without a refusal names the database's own reason with its SQLSTATE, read off
the driver error under drizzle's wrapper (`packages/core/src/lib/db-errors.ts:pgDriverError`) and
passed through `@forge/observability`'s redaction, and says that reason is for whoever operates
Forge, not an act on the issue. A schema object's name the driver error carries
(`packages/core/src/lib/db-errors.ts:pgObjectNames`) that the query-error seal cut a bound value
out of is named whole once. It goes back into the message only in Postgres's own integrity message
(SQLSTATE class 23), which quotes its constraint once after `constraint `, and only where that cut
stands there once; anywhere else the cut may be a different quote sealed alike, so the name is
named beside the reason (`the database names constraint "…"`). A name that is a bound value stays
out. Any other cut in the message reads "(a value of this write, withheld)". Where a bound value
would survive outside those names, the SQLSTATE's class description stands in (`packages/core/src/lib/db-errors.ts:pgErrorClassDescription`).
The SQL statement and its bound values reach neither the comment nor the finish answer's
`failed[].reason` (ISS-1381 r2). The comment is written as the finishing person or, for a finish a box reported, as
that box's owner.

Nothing here reads when such a fault is fixed, so Release now stays on offer, and the comment, the
issue's awaiting-release banner and its row on the release gate panel each say a release started
there fails the same way until it is (ISS-1381 r4). The finish keeps each close it could not make on
its own run, `pipeline_runs.metadata.closeFailures[issueId]` — kind, reason, version, the comment,
and the earlier releases it repeats (`packages/core/src/release-batch/close-failures.ts:sayCloseFailure`).
The roster answer's `closeFailure` is the latest such record where it failed short of a decision
(`packages/core/src/release-batch/close-failures.ts:lastCloseFailures`). A later finish that fails
the same issue with the same kind and reason rewrites that comment, naming every release that met
it, rather than posting another.

A record is the issue's word only until its status next moves into or out of `closed`
(ISS-1381 r5): `lastCloseFailures` leaves out a record that `kernel_transitions` shows such a move
after, and the record's `at` is stamped on the database's clock, the one those rows carry. An issue
that left `closed`, by whatever move `packages/core/src/pipeline/state-machine.ts:canTransitionFree`
admits, has a row recording that exit, and retention deletes an issue's transitions only while it
is closed or dropped, so an issue at the gate or at `releasing` keeps the row that ends a record
from before its close. An issue a release closed and that came back to the
gate therefore names no old failure, and a failure after that close posts a comment of its own
rather than rewriting the one from before it. A move off the gate and back that never passes
through `closed` leaves the record standing. On the release gate panel such a row is not counted
ready and select-all leaves it out; picked by hand, the batch dialog names it as one this release
fails to close the same way and says only the others close.

## 4. Which route reads the repository (ISS-1398)

Every repository read a release takes — the carried range above, and the weighing the automatic
release judges a verdict with (`packages/core/src/release-batch/runtime-weighing.ts:readWeighingNow`:
whether what production serves descends from the commit a verdict was judged at, the files the two
differ in, and the files a landing changed) — goes through one port,
`packages/core/src/projects/repository-reader.ts:RepositoryReader`, which
`packages/core/src/projects/repository-access.ts:withRepository` hands out:

- **The project's active GitHub binding**, where it has one. A binding that exists and cannot be
  used is refused in GitHub's words; it never falls back to the key.
- **Otherwise the SSH deploy key attached under Settings → Runners → Git access**, beside an SSH
  repository URL — the same key a runner clones and pushes with, which is why every sentence that
  asks for access for it asks for write access. `packages/core/src/git/repository-reading.ts`
  reads with plain git: every branch's commits once per reading (`--filter=tree:0`), and only the
  trees of the commits a file question compares (`--depth=1 --filter=blob:none`), never a file's
  contents, each fetch held to the byte and time budget of `packages/core/src/git/bounded-fetch.ts`.
  This is how a project hosted on GitLab, or anywhere but GitHub, is read; no host API is asked.
- **Neither**: no read is taken. The weighing's criterion stays unearned with the reason beside it,
  naming the SSH clone URL and deploy key to attach.

A read that fails on either route is a reason, never an answer: a carriage that could not be read
leaves the criterion weighed by equality alone, so a failed read can hold a verdict and never earn
one. The hold names each failed read by its cause beside the criterion it holds, and says the act
that makes the repository readable once, at the head of its remedy, ahead of recording a verdict
(`packages/core/src/pipeline/release-hold.ts:criteriaHold`). Readiness's `RELEASE_CRITERIA_UNEARNED` and its
`RELEASE_CRITERIA_HELD_BACK` warning lead with the same act, once, ahead of the verdicts
(`packages/core/src/release-batch/criteria-hold.ts:criteriaHold` carries it as `details.clears`).
A judged or served commit named by more digits than a whole sha is never read as carried: the
carriage is unread, naming the length, before the host is asked.
