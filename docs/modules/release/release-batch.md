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
  `compare(live...cut)` from the project's GitHub binding, every page of it.
- `packages/core/src/release-batch/carried.ts:readCarried` names every issue of the project whose landing commit is in the range and
  that is not on the roster, whatever its status: a `needs_info` issue, one being judged, or one
  closed while its landing never reached the live branch.
- `packages/core/src/release-batch/carried.ts:judgeCarried` requires a decision for each, sent in the create body's `carried`:
  - `ship-unverified` with `why`: what is unverified. It goes on the run's `metadata.carried`, and
    `packages/core/src/release-batch/carried.ts:noteShipUnverified` writes a comment on the issue naming the release version, the
    run and the reason.
  - `revert`: holds only where the range holds an effective revert of the landing — a commit whose
    message says `This reverts commit <landing>` that no later commit reverts in turn.
  - `cut-below`: moves the cut to the first parent of the earliest such landing and reads the range
    again to that cut. It is refused where a roster member's landing would fall above the new cut.

Each outcome has its own code:

| reading | answer |
|---|---|
| an issue in the range holds no decision | `RELEASE_CARRIES_UNDECIDED` (409), each issue named with its status and the ways out |
| a decision that does not hold | `RELEASE_CARRIED_DECISION_REFUSED` (409), the issue and why |
| a cut-below that drops a roster member | `RELEASE_CUT_DROPS_ROSTER` (409), each member it drops |
| the bound repository fails to answer | `RELEASE_CHECK_UNEVALUATED` with check `carried` (503) |
| the project has no GitHub binding | not refused: warning `RELEASE_CARRIED_UNREAD`, saying how to bind it |
| a publish chain or a cherry-pick crossing | not refused: `carried.kind` is `not-read` with its reason |

The create answer carries `carried` (the cut and each issue with its decision) and the warnings. The
release job's prompt (`packages/core/src/release-batch/prompt.ts`) tells the agent the exact cut to promote, not the branch head. The
release screen's readiness (`packages/core/src/release-batch/readiness.ts:loadReleaseReadiness`) runs the same check before anyone
presses. The batch release dialog lists each carried issue with Ship unverified (a reason is
required), Reverted or Cut below, and sends the decisions when release is pressed again.

A refused create claims no issue and leaves no open run.

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
| any other end, never dispatched | `ended`, with the job's error |
| no release job under the run | `none` |

`packages/core/src/release-batch/unstarted-recovery.ts:recoverUnstartedReleaseBatches` hands back a batch still `waiting` after
`packages/core/src/release-batch/job-start.ts:RELEASE_UNSTARTED_DEADLINE_MS`. It finds those batches with the same predicate,
`packages/core/src/release-batch/job-start.ts:unpickedJobSql`, so the reading and the hand-back cannot disagree about which batch
is unstarted. The run screen prints `waiting` and `claimed` as "No box has started this release",
`handed-back` and `ended` as "This release never started", and `none` as "This run holds no release
job", each with the reading's own why and, for `waiting`, the hand-back time. It prints nothing for
`taken`. On the release gate, a claimed issue reads "in a release", not "shipping now".

## 3. The finish

The job reports through `forge_release_batch` `finish` (or the REST `finish` route).
`packages/core/src/release-batch/finish-job.ts:acceptReleaseBatchFinish` records it and queues it, and
`packages/core/src/release-batch/finish-job.ts:runReleaseBatchFinish` runs `packages/core/src/release-batch/service.ts:finishReleaseBatch`, which closes each issue
on the roster. `packages/core/src/release-batch/finish-precondition.ts:assertFinishable` decides whether a run can be finished at
all.

### A close that is refused (ISS-1381)

One issue's refused close does not stop the others from closing. The refused issue goes back to
`awaiting_release` through `packages/core/src/release-batch/releasing-recovery.ts:recoverStrandedReleasing`, and the comment it
leaves (`packages/core/src/release-batch/releasing-recovery.ts:refusedCloseComment`) says:

- that the release it was in has shipped, with its version;
- the refusal by its code (`OPEN_QUESTIONS`, say), and every blocking object the refusal reports —
  each id under a `*Ids` key of its details, labelled (`open question <id>`);
- what clears it, which is the refusal's own detail;
- how it closes once cleared: a release record naming the commit production serves, or the next
  batch.

A close that failed without a refusal names the error and says the close is sent again once that
error is gone. The comment is written as the finishing person or, for a finish a box reported, as
that box's owner.
