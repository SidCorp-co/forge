# The merged mark: what the two columns mean

`packages/core/src/issues/merge-record.ts` is the only writer of
`issues.merged_at`, `issues.merged_commit_sha`, `issues.merged_landing` and `issues.merged_artifacts` —
`scripts/check-merged-at-writers.mjs` holds that — and `mergeMarkKindOf`, in the same file, is the
only reading of what the columns MEAN.

| `merged_at` | `merged_commit_sha` | `merged_landing` | kind |
|---|---|---|---|
| empty | — | — | `unmarked` |
| set | empty | empty | `asserted` |
| set | empty | text | `landed` |
| set | a sha | — | `observed` |

`landed` (ISS-1327) is a mark that names where work landed OUTSIDE git — a live URL, a CMS entry,
a published storefront resource. Like `asserted` it is somebody's word, not a merge Forge
witnessed; unlike `asserted` it names the thing that landed. The table's
`issues_merged_landing_chk` refuses a landing with no `merged_at`, blank, or past 2000 characters.

`asserted` is not a half-written row. It is ISS-959's encoding for a merge nobody here
observed: somebody's claim that work shipped. `observed` is a merge Forge holds its own
record of — a pull request it saw merged, or a commit it read from the project's repository
itself (below). The two are as different as a receipt is from a promise, and until ISS-1126
the distinction lived only in the columns — every surface that wanted it had to re-derive
it from a null test, and none of them did. Measured on forge-dev, 2026-09-20: 851 of 851 marks
were asserted and nothing an agent read said so.

A second place deciding what the pair means would be the single-writer defect one axis
over: a reader that disagrees with the writer about which state it is looking at is how
state starts lying.

## An empty string is not a commit

The column is plain text with no check constraint, so `''` is representable. `observed`
is a claim that Forge holds a record of the merge; a column holding nothing is not that
record, whichever of `null` and `''` it holds. `merged_at` decides first: a sha with no
timestamp is `unmarked`.

## What `POST /api/issues/:id/merge` writes, on each path

`applyMergeMarker` looks for a merged pull request Forge has projected
(`observedMergeForIssue`). Where it finds one it stamps `merged_at` AND
`merged_commit_sha`, from that record. Where it finds none it stamps `merged_at` alone.

Where an agent marks an issue on the `git` shape that holds no other work evidence
(`findMissingWorkEvidence`) and the call carries `commit`, the commit is the only trace
the work left: it landed on the base branch itself, where no branch of its own exists
(ISS-1318). `readCommitLanding` (`packages/core/src/issues/commit-landing.ts`) reads it from the
project's repository through its GitHub binding. It counts only where the repository resolves
it, its subject declares this issue by `declaredIssueSeqs` — the rule `commitOwners` places
commits with, so a base-branch commit that is another issue's landing is refused — and the base
branch or the release chain's live branch contains it. Then `merged_at` and
`merged_commit_sha` are stamped with the full sha the repository resolved and its committer
date, and the mark reads `observed`. Every other answer is a refusal by name and writes
nothing: `COMMIT_NOT_IN_REPOSITORY`, `COMMIT_NOT_THIS_ISSUE`, `COMMIT_NOT_LANDED`, and
`COMMIT_UNVERIFIED` where the repository could not be read — a commit is never taken as
evidence unchecked.

Where the caller names a `landing` and no merged pull request exists, it stamps `merged_at` AND
`merged_landing`. On every path but the one above, the caller's `commit` never reaches the
column — it reaches the audit trail as the caller's claim.

A merged commit on the row is work evidence: `collectWorkEvidence`
(`packages/core/src/issues/work-evidence.ts`) reads `merged_commit_sha` where `merged_at` is
set, so an issue the mark accepted is not refused `NO_WORK_EVIDENCE` on its next move.

Where the row already holds a stamp, the gated UPDATE moves nothing and the answer
describes what the row HOLDS, not which branch this call took. So the "your commit is not
what the column holds" clause compares the claim against the column. Comparing it against
the row the call happened to select tells a caller its own commit was overruled by that
same commit.

A `landing` is the one input that repeat does not answer: where a mark stands and the landing sent
is not the one it names — a corrected typo, or a landing sent over a mark naming none — the call is
refused `MARK_ALREADY_STANDS` (`standingMarkRefusal`), naming what stands and `unmark` then mark as
the correction, and neither the row nor the thread is written. The first stamp wins for the landing
as for `merged_at`; a `200` that kept the old landing while the caller was told it had sent the
evidence is what this replaced (ISS-1327). The exact landing re-sent is answered `already_merged`
like any other repeat.

## What a landing says it changed

`issues.merged_artifacts` (0433) holds what a landing changed, one `{surface, ref, change}` per
artifact: `surface` is one of `LANDING_SURFACES` (`packages/contracts/src/landing-artifacts.ts`) —
`ui`, `api`, `logic`, `data`, `config`, `runner`, `design` — and `change` one of `added`, `changed`,
`removed`. A surface or change outside those is refused by name at the route. It is written in the
stamp's own UPDATE and cleared with it by `unmark`; `issues_merged_artifacts_chk` refuses a list with
no `merged_at`, or one that is empty or not an array. NULL is a landing naming nothing structured.

- **Outside git** the mark takes `artifacts` beside `landing`. A landing naming a design revision —
  `forge-workflow:<flow>@rev<n>`, or the sentence a design approval writes — is surface `design`
  without being told (`designLandingRef`), and a non-design artifact beside it is refused
  `ARTIFACTS_NOT_DESIGN`: a revision deploys nothing. Artifacts sent over a standing mark that names
  others are `MARK_ALREADY_STANDS`, as a landing is.
- **On git** the mark refuses `artifacts` (`ARTIFACTS_NOT_THIS_SHAPE`): what a git landing changed is
  its commit's changed paths against its first parent, sorted by the project document's `surfaces` —
  ordered `rules` of globs per surface, first match wins, and `ignore` for paths that ship nothing.
  forge-core's own map is `packages/core/tests/fixtures/forge-core-surfaces.json`, which a project
  on that tree copies into its document; no repository name brings a map. A project declaring none
  has its paths shown unclassified, never sorted by a guess. The paths come from one of two readers,
  and the release read names which:
  - `host` — Forge observed the merge (`merged_commit_sha`), and the source host lists the commit's
    files (`changedFilesOf`).
  - `box` — the project has no source host Forge can read, so `forge-runner api`, carrying a mark that
    names a `commit` its checkout holds, adds `changedPaths` (`git diff --name-status <first parent>
    <commit>`, paths only). The mark stores them in `merged_paths` labelled `read: 'box'`
    (`markReadPaths`, `recordReadPaths`): the box's reading of its own checkout, not a merge Forge
    observed. Paths read at another commit than the mark names are `CHANGED_PATHS_UNMATCHED`, paths
    outside git `CHANGED_PATHS_NOT_THIS_SHAPE`, and paths over a standing reading of another commit
    `MARK_ALREADY_STANDS`.

  A mark with neither has no paths to read.
- **A design approval** writes the revision's `design` artifact on either shape (below). On git, an
  observed commit on the same issue is still read, and its artifacts are named beside the revision;
  with no observed commit and no box-read paths the revision is named and the rest reads unread, so
  the issue is listed under `unclassified` and the release never reads as shipping nothing. The
  approval stamps first, so a run's later claim of a commit reaches no column (FB-105: ISS-350 in
  0.4.0-dev.113 changed code and read as a design revision alone).

The release read (`packages/core/src/release-batch/landing-surfaces.ts`) groups them into the release's
`changes`: per surface its artifacts and the issues touching each, `design` marked as shipping
nothing, and a risk where the data says so — a `data` artifact removed or changed, an `api` artifact
removed. An issue whose landing leaves anything unnamed — all of it, a commit not read, or paths no
rule claims — is listed under `unclassified` with why, so the summary never reads complete when it
is not. Rows marked before 0433 are not backfilled: their prose landings read `unclassified` with
why, an amnesty that ends as each of those issues releases.

## What a design approval writes

A workflow design revision drawn under a design issue is that issue's deliverable, so approving it is
where the work landed. `decideDesignAs` (`packages/core/src/workflows/design-service.ts`) records it in
the decision's own transaction through `markApprovedDesign` (`packages/core/src/issues/design-landing.ts`),
whose one write is `recordDesignLanding` here, its `issue.updated` carrying `via: 'design'`. Where it
writes, it also sets `merged_artifacts` to the revision's one `design` artifact, `<flow>@rev<n>`.

An issue linked as the build of a workflow (`workflow_builds`, `POST …/workflows/:workflow/builds`) is a
build issue: its deliverable is that build, so a revision drawn under it is not its landing. The
approval writes no mark there and posts a notice naming the revision as evidence, the build it delivers
and the mark it leaves; the decision answers `designIssue.action` `evidence`, `why` naming the workflow it
builds. The link is the one signal Forge holds of what an issue delivers — the same link
`WORKFLOW_DESIGN_ISSUE_IS_BUILD` keeps apart from the drawing issue of one workflow — so an issue with no
build link is read as a design issue. Measured on dev.87, 2026-10-07: HOP ISS-69, building
`hop-product-tour`, carried `merged_at` from the approval of `hop-attention-queue-ux` revision 1 while open
and unbuilt; the forecast read it landed, and its build's own landing would have met
`MARK_ALREADY_STANDS`. Migration 0435 clears the marks an approval wrote on an unreleased build issue,
attributing each by the approval's notice at its stamp, and aborts naming any it cannot attribute. On a
design issue the table below holds:

| shape | the row holds | the approval |
|---|---|---|
| `outside_git` | no mark, or a mark somebody's word wrote (`asserted`, `landed`) | stamps `merged_at` and sets `merged_landing` to the approved revision — `repointed` where a mark stood, the landing it replaced named in the notice it posts |
| `outside_git` | a merge Forge `observed` | keeps it |
| `git` | no mark | stamps `merged_at` (`asserted`: a git mark names no revision; the notice names it) |
| `git` | any mark | keeps it |

A dropped, closed or archived issue, and a project with no project document, are not marked; the
decision's answer says which (`designIssue.action` `none` with its `why`). A closed issue has shipped
and its mark is what the release that closed it read, so an approval after the close leaves it as it
shipped and posts a notice saying so. This is the one place a mark standing
on somebody's word is replaced rather than refused `MARK_ALREADY_STANDS`: a landing written at
propose names a revision that was not yet approved, and the approval is better evidence than that
word (ISS-262). Like every mark it moves no status.

The forecast (`packages/core/src/forecast/`) does not read an issue landed by `merged_at` alone: it reads
landed by status — `awaiting_release` or `closed` — so an open issue carrying a mark is forecast as work,
holds its dependents, and is no sample of the landed history.

## What a mark does to the issue

Nothing beyond the record. Recording a landing — a mark on either door, a design approval, or the
source host's merge webhook — writes the merge columns and moves no status and no hold (owner decision 2026-10-04,
workflow `issue-lifecycle` rev 8). The run that holds the issue moves it `in_progress` →
`awaiting_release` itself, an edge that asks for the recorded merge (`MERGE_NOT_RECORDED`) and the
verdicts the project's `delivery.verdictsRequired` asks for; when the run ends without doing so, the
kernel hands the issue back to the status the run took it from. `awaiting_release` → `closed` is
written only by a release that claimed the issue (`CLOSE_ONLY_BY_RELEASE`), and needs the merge too
(`CLOSE_REQUIRES_SHIPPED`).

## A mark written after the release that shipped it

An issue can reach `awaiting_release` after a release whose range already holds its work. That release
never claimed it, so every later cut finds nothing new in its own range and aborts naming a person.
`closeShippedEarlier` (`packages/core/src/release-batch/shipped-earlier.ts`) settles it as a kernel
fact. It runs in the automatic sweep before a row held `RELEASE_ABORT_BLOCKED` is set aside, and at the
top of `createReleaseBatch`, and it places the issue in a shipped release (a run whose finish is
`finished`, with `finish.commit` the commit the probes verified live) by one of two evidences:

- an `observed` mark names a commit: the release is the earliest whose commit holds it.
- an `asserted` mark whose audit comment recorded a claimed commit (`mark_merged … commit=<sha>`, the
  only place the tracker keeps it, read in exactly that shape) is placed like an observed one by that
  commit, once the host confirms it; a claim in no shipped release is not placed by it.
- an `asserted` mark with no claim the host confirms is placed by declaring commits: the
  repository is asked which commits declare the issue, by `commitOwners`, in each of the last twelve
  releases' own ranges. The release is the one whose range holds the last declaring commit, and only
  where the range from the newest release to the branch head holds none: work still unreleased is not
  shipped. A `landed` mark is outside git and is never placed this way.

Where the project has no source host binding at all (or declares a local repository no host serves),
the commit the first two evidences name is asked instead of the box holding the project's bound
checkout: core sends `checkout.ancestry.read` to the first connected box whose runner binds a checkout
of the project (oldest binding first; a box bound to no runner of the project is never asked), the
box answers `git merge-base --is-ancestor` per pair, fetching origin only where a commit is missing,
and posts it to `/api/devices/me/checkout-ancestry/:requestId`
(`packages/core/src/runners/checkout-ancestry.ts:answerCheckoutAncestry` checks it against the
pairs asked and the declared repository). The placement rule is the same, and the notice names the
box-read evidence: the box, its checkout, origin, read time and both shas. The declaring-commits
evidence stays host-only, since it reads ranges of commit messages no box serves. A binding that exists
and cannot serve is not stood in for by a box. No box answering (none bound, none connected, or one
that let a read lapse, which is not asked again for ten minutes) is `SHIPPED_EARLIER_HOST_UNAVAILABLE`
naming both reasons; a box that answered it could not read a commit is `SHIPPED_EARLIER_UNREAD`.
A row whose mark names no commit (no `merged_commit_sha`, no claimed `commit=`) is never offered a box: only the declaring-commits evidence could place it, so a connected box is not a way out. That row is `SHIPPED_EARLIER_NO_COMMIT`, and its hold names the two ways out: a source host binding, or its mark naming the landing commit (`unmark`, then mark again with `commit=<sha>`).

The issue is closed through the release's own close (`closeRoster`, after `claimIssuesForRelease` onto
that run), so `CLOSE_ONLY_BY_RELEASE` still holds and the run's `rosterClosed` names it. It gets a
notice naming the version, and its hold is cleared. It adds no changelog fragment: its notes belong to
the release that shipped it. A repository that cannot be read, or a range it will not give whole, is
`SHIPPED_EARLIER_HOST_UNAVAILABLE` or `SHIPPED_EARLIER_UNREAD`, and a close the release path refuses is
`SHIPPED_EARLIER_NOT_CLOSED`: nothing moves and no version is inferred. The sweep says it on the row's
hold, as a clause beside whatever holds it — an abort hold keeps its code and the act it names
(`packages/core/src/release-batch/shipped-earlier-hold.ts:withShippedEarlier`) — and takes the clause
back on the sweep that can settle it.
A work older than twelve releases is not placed, and takes the normal path.

A row still claimed by a release that ended without shipping is read the same way
(`packages/core/src/issues/release-claim.ts:heldByEndedRelease`: the claiming run is not live and
carries no ship stamp). A run that failed after it recorded a deploy keeps its roster claimed at the
release step for a person, since its code may be live; a later shipped release whose commit holds the
row's is that answer. The sweep (it also visits a project for such a row alone) and the top of every
cut ask it, the close takes the claim over from the ended run (`claimIssuesForRelease`
`fromEndedRelease`), and the notice names the release that held it. A row no shipped release holds,
or one the close refuses, goes back to the ended run's claim at its release step
(`returnTakenClaims`); a row a live run holds is never read. The ended release's page still lists the
row, now `closed` and waiting on nobody; the shipped release's page lists it too, from its
`rosterClosed` (`packages/core/src/release-batch/versions.ts:issueIdsOf`).

## What counts as landed depends on the project's shape

`packages/core/src/issues/landing-evidence.ts` is the one answer, and every door that decides
whether a mark is enough calls it: the `merged` guard (`packages/core/src/issues/merged-at.ts:mergeNotRecorded`), the release-record
door's `RELEASE_WORK_UNMERGED`, and the mark writer. The release
batch's finish closes through the same transition, so it reads the same answer.

`landingShapeOf` reads the project document's `source.type` (`project_config_documents`): `git`
lands in `git`; `storefront` (the store is the source of truth) and `none` (no managed source) land
`outside_git`; any other stored value is refused by name. A project with no project document has no
shape (`null`): the close and the release-record door then accept only what every shape accepts —
a merge Forge `observed` — and refuse anything else naming `SOURCE_UNDECLARED`, the mark writer
refuses every mark `PROJECT_DOCUMENT_NOT_FOUND`, and the issue detail answers `landingShape: null`.
Nothing defaults an undeclared project to `git`.
The release chain is NOT the discriminator: a one-entry chain (`publish`) says how a release is
deployed, and forge-dev is such a project and lands every change in git.

| shape | `LANDINGS_ACCEPTED` | the mark writer refuses |
|---|---|---|
| `git` | `asserted`, `observed` | a `landing` (`LANDING_NOT_THIS_SHAPE`); no `target` |
| `outside_git` | `landed`, `observed` | no `landing` where Forge observed no merged pull request (`LANDING_REQUIRED`) |

`target` names the branch a mark merged through, so it is owed on `git` alone
(`markTargetRequired`); each door answers a missing one in the words it always used.

A close refusal names the route the shape has (`landingRoute`): `POST /api/issues/:id/merge` for
`git`, and the same route carrying `landing` for `outside_git`, where no commit is asked for. The issue detail
answer carries `landingShape`, so the web rail's Mark merged form asks for a landing only where the
close will need one, without re-deriving the rule from the project document.

`trg_issues_closed_means_shipped` (0304) still requires `merged_at` alone: it is the floor raw SQL
cannot route around, and `merged_at` is necessary on every shape. The per-shape sufficiency is not
copied into plpgsql, because a second copy is a second decider.

Rows closed before this rule on an `outside_git` project are not rewritten and are not false marks:
on a project whose work never lands in git, no commit and no `merged_at` is its normal record, and
the owner has ruled those rows correctly closed (ISS-1327). The rule governs the next close, not
the ones already made. Outside git a mark is short of a *landing*, never of a commit, and every
sentence the shortfall prints says so.

## Why the git shape accepts a claim

On the `git` shape the mark writer and the close accept `asserted`: `LANDINGS_ACCEPTED.git`.

That is an amnesty and this is its price. `observedMergeForIssue` needs a
`repo_pull_requests` row in state `merged`; until ISS-1123 (`9a78b0c93`) nothing but an
inbound webhook could write one, and as of 2026-09-20 no inbound delivery had been recorded
on this project's binding. Refusing asserted marks then would have failed the criterion on
every issue the project has and stopped every run.

**What ends it:** when observed marks are being written here — a pull request opened
through Forge and merged through the kernel door leaves a row and stamps the commit —
`LANDINGS_ACCEPTED.git` narrows to `['observed']`. Narrowing the constant is the whole change;
every door is gated on membership of it, so nothing else moves.
