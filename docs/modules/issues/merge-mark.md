# The merged mark: what the two columns mean

`packages/core/src/issues/merge-record.ts` is the only writer of
`issues.merged_at`, `issues.merged_commit_sha` and `issues.merged_landing` —
`scripts/check-merged-at-writers.mjs` holds that — and `mergeMarkKindOf` is the only reading of
what the columns MEAN.

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

## What `mark_merged` writes, on each path

`applyMergeMarker` looks for a merged pull request Forge has projected
(`observedMergeForIssue`). Where it finds one it stamps `merged_at` AND
`merged_commit_sha`, from that record. Where it finds none it stamps `merged_at` alone.

Where an agent marks an issue on the `git` shape that holds no other work evidence
(`findMissingWorkEvidence`) and the call carries `data.commit`, the commit is the only trace
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
evidence unchecked. That refusal names two routes: mark again once the repository can be read
(or, where the project names no base branch, once it does), or have a person mark it merged and
move it through `developed` and `testing`, since a person's mark carries no commit Forge read. GitHub answers an abbreviated sha that no commit starts with and one that
several commits start with alike, so such a sha is refused `COMMIT_NOT_IN_REPOSITORY` as
unresolved, asking for the full sha, and never reported as absent.

Where the caller names a `landing` and no merged pull request exists, it stamps `merged_at` AND
`merged_landing`. On every path but the one above, the caller's `data.commit` never reaches the
column — it reaches the audit trail as the caller's claim. That is why the tool description
states the condition the column is written under rather than a blanket "always" or "never":
both blankets have been written into it and both were false.

A merged commit on the row is work evidence: `collectWorkEvidence` reads `merged_commit_sha`
where `merged_at` is set, so an issue the mark accepted is not refused `NO_WORK_EVIDENCE` at
`developed` or `testing` one status later. The `NO_WORK_EVIDENCE` refusal
(`packages/core/src/pipeline/work-evidence.ts:noWorkEvidenceDetail`) offers that commit route
on the `git` shape only, and to an agent only. On `outside_git` it names the branch and handoff
routes and a person's mark and move, which the agent-only gate does not hold.

The `work_evidence` entry criterion runs the same check and holds a person as well, so its refusal
is read by `anyone` (`EvidenceReader`): it names the branch and handoff routes, says a person's mark
records no commit Forge read and does not clear it, and names `statusEntryCriteria` as the
declaration to change where the project's work leaves none of these.

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

## What counts as landed depends on the project's shape

`packages/core/src/issues/landing-evidence.ts` is the one answer, and every door that decides
whether a mark is enough calls it: the close gate (`refuseUnshippedClose`), the `merged_mark` entry
criterion, the release-record door's `RELEASE_WORK_UNMERGED`, and the mark writer. The release
batch's finish closes through the same transition, so it reads the same answer.

`landingShapeOf` reads `projects.kind`: `website` — the store is the source of truth and a repo is
optional — lands `outside_git`; `standard` lands in `git`; any other value is refused by name
(`UnknownProjectKindError`), and the mark writer answers it `PROJECT_KIND_UNKNOWN`, naming the
kind, the known kinds and the route that sets one, with nothing written. Every route that writes
`projects.kind` validates it, so only a write outside them leaves such a value; the column
constraint that would refuse it there is priced in
`docs/proposals/a-project-kind-forge-does-not-know-is-accepted-at-write.md`.
The release chain is NOT the discriminator: a one-entry chain (`publish`) says how a release is
deployed, and forge-dev is such a project and lands every change in git.

| shape | `LANDINGS_ACCEPTED` | the mark writer refuses |
|---|---|---|
| `git` | `asserted`, `observed` | a `landing` (`LANDING_NOT_THIS_SHAPE`); no `target` |
| `outside_git` | `landed`, `observed` | no `landing` where Forge observed no merged pull request (`LANDING_REQUIRED`) |

`target` names the branch a mark merged through, so it is owed on `git` alone
(`markTargetRequired`); each door answers a missing one in the words it always used.

A close refusal names the route the shape has (`landingRoute`): `mark_merged` for `git`, and
`mark_merged` with `data.landing` for `outside_git`, where no commit is asked for. The issue detail
answer carries `landingShape`, so the web rail's Mark merged form asks for a landing only where the
close will need one, without re-deriving the rule from `kind`.

`trg_issues_closed_means_shipped` (0304) still requires `merged_at` alone: it is the floor raw SQL
cannot route around, and `merged_at` is necessary on every shape. The per-shape sufficiency is not
copied into plpgsql, because a second copy is a second decider.

Rows closed before this rule on an `outside_git` project are not rewritten and are not false marks:
on a project whose work never lands in git, no commit and no `merged_at` is its normal record, and
the owner has ruled those rows correctly closed (ISS-1327). The rule governs the next close, not
the ones already made. Outside git a mark is short of a *landing*, never of a commit, and every
sentence the shortfall prints says so.

## Why the git shape accepts a claim

On the `git` shape `merged_mark` and the close accept `asserted`: `LANDINGS_ACCEPTED.git`.

That is an amnesty and this is its price. `observedMergeForIssue` needs a
`repo_pull_requests` row in state `merged`; until ISS-1123 (`9a78b0c93`) nothing but an
inbound webhook could write one, and as of 2026-09-20 no inbound delivery had been recorded
on this project's binding. Refusing asserted marks then would have failed the criterion on
every issue the project has and stopped every run.

**What ends it:** when observed marks are being written here — a pull request opened
through Forge and merged through the kernel door leaves a row and stamps the commit —
`LANDINGS_ACCEPTED.git` narrows to `['observed']`. Narrowing the constant is the whole change;
every door is gated on membership of it, so nothing else moves.

## Why the tests run at the route and at the handler

ISS-1126's criterion 14 names the surfaces of criteria 3 to 7: `POST|DELETE
/api/issues/:id/merge`, and `forge_issues`'s `get`, `list` and `mark_merged`. A test that
called `applyMergeMarker` or a serializer directly proves those helpers and nothing about
the runtime the criterion names — a route that dropped `mark` from its `c.json`, or a
handler that mapped every row through one reading, would stay green through it. So
`packages/core/src/issues/merge-mark-route.test.ts` mounts the Hono routes and
`packages/core/src/mcp/tools/forge-issues-merge-mark.test.ts` calls the tool factory's own
handler. `packages/core/src/issues/merge-mark-surfaces.test.ts` keeps the helpers' own
property, which is a different claim.

The observed branch is only ever exercised under a mocked projection: on any database
here `repo_pull_requests` is empty, so the branch is unreachable in the field.
