# The merged mark: what the two columns mean

`packages/core/src/issues/merge-record.ts` is the only writer of
`issues.merged_at`, `issues.merged_commit_sha` and `issues.merged_landing` —
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

## What a mark does to the issue

Nothing beyond the record. Recording a landing — a mark on either door, or the source host's merge
webhook — writes the merge columns and moves no status and no hold (owner decision 2026-10-04,
workflow `issue-lifecycle` rev 8). The run that holds the issue moves it `in_progress` →
`awaiting_release` itself, an edge that asks for the recorded merge (`MERGE_NOT_RECORDED`) and the
verdicts the project's `delivery.verdictsRequired` asks for; when the run ends without doing so, the
kernel hands the issue back to the status the run took it from. `awaiting_release` → `closed` is
written only by a release that claimed the issue (`CLOSE_ONLY_BY_RELEASE`), and needs the merge too
(`CLOSE_REQUIRES_SHIPPED`).

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
