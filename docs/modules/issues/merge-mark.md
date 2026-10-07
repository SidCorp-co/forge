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
project's repository — through its GitHub binding, or, on a project with no binding (one hosted on
GitLab, say), with git as the deploy key attached under Settings → Runners → Git access (ISS-1398;
the route is `packages/core/src/projects/repository-access.ts:withRepository`'s, and
`docs/modules/release/release-batch.md` says how each reads). It counts only where the repository resolves
it, its subject declares this issue by `declaredIssueSeqs` — the rule `commitOwners` places
commits with, so a base-branch commit that is another issue's landing is refused — and the base
branch or the release chain's live branch contains it. Then `merged_at` and
`merged_commit_sha` are stamped with the full sha the repository resolved and its committer
date, and the mark reads `observed`. Every other answer is a refusal by name and writes
nothing: `COMMIT_NOT_IN_REPOSITORY`, `COMMIT_NOT_THIS_ISSUE`, `COMMIT_NOT_LANDED`, and
`COMMIT_UNVERIFIED` where the repository could not be read — a commit is never taken as
evidence unchecked. On the git route the cause is one of four, read from what the host said
(`packages/core/src/git/bounded-fetch.ts:fetchRefusal`) and quoted in its words past any `remote:`
banner: the host refused the key, it took the key but will not let it read that repository (or none
is there), it could not be reached, or the repository lacks a branch. That refusal names two routes:
mark again once the repository can be read — or, where a branch is missing, once the repository has
it or the project names only branches it has —
through the GitHub binding where the project reads through one, else with the deploy key over the SSH
clone URL under Git access, and never telling a project with no binding to bind GitHub, except
beside the key for a github.com remote — (or, where the project names no base branch, once it does), or have a person mark it merged naming
no commit and move it through `developed` and `testing`, which hold an agent to this evidence and not
a person; a person's mark naming a commit is checked against the same repository (below). GitHub
answers an abbreviated sha that no commit starts with and one that
several commits start with alike, and git resolves a prefix only against the commits its branches
hold, so on either route such a sha is refused `COMMIT_NOT_IN_REPOSITORY` as
unresolved, asking for the full sha, and never reported as absent. A full sha no branch holds is
fetched by itself on the git route, and the host serving no such commit is the absent answer.

Where the caller names a `landing` and no merged pull request exists, it stamps `merged_at` AND
`merged_landing`. On every path but the one above, the caller's `data.commit` never reaches the
column — it reaches the audit trail as the caller's claim. That is why the tool description
states the condition the column is written under rather than a blanket "always" or "never":
both blankets have been written into it and both were false.

A merged commit on the row is work evidence: `collectWorkEvidence` reads `merged_commit_sha`
where `merged_at` is set, so an issue the mark accepted is not refused `NO_WORK_EVIDENCE` at
`developed` or `testing` one status later. The `NO_WORK_EVIDENCE` refusal
(`packages/core/src/pipeline/work-evidence.ts:noWorkEvidenceDetail`) offers that commit route
on the `git` lane only, and to an agent only, and tells that lane how an issue whose change lands
no file in the repository declares itself `outside_git`.

On an `outside_git` lane the landing a mark names is the work evidence (ISS-1384):
`collectWorkEvidence` reads `merged_landing` where `merged_at` is set and the lane is
`outside_git`, and an agent's `mark_merged` carrying `data.landing` is let through with nothing
else behind it, because the landing IS the trace such work leaves. The refusal on that lane names
the landing route and never `data.commit`. Its price is below.

The `work_evidence` entry criterion runs the same check and holds a person as well, so its refusal
is read by `anyone` (`EvidenceReader`): it names the branch and handoff routes, says a person's mark
naming a commit is checked only for the repository holding it, not read as this issue's landing, so
it does not clear it, and names `statusEntryCriteria` as the
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

## Every `git` mark's commit is one the repository holds

A claim is still checked (ISS-1350). On a `git` project every commit a mark records — a person's,
an agent's on an issue that has a branch or handoff, one beside a merged pull request — is first
resolved by the project's repository (`packages/core/src/issues/commit-landing.ts:resolveMarkCommit`, the same commit
read `readCommitLanding` takes). The repository holding no such commit refuses the mark
`COMMIT_NOT_IN_REPOSITORY`; a repository that cannot be read refuses it `COMMIT_UNVERIFIED`, naming
why, and a mark naming no commit is the route that still records. A resolved commit is recorded by
the full sha the repository gives, never as the caller typed it. It stays a claim: Forge read that
the repository holds it, not that it is this issue's landing, so `merged_commit_sha` is not stamped
from it and the answer says which of the two Forge read. The one commit not read is the merged pull
request's own merge sha, which Forge already holds.

Where the caller names no commit, the mark falls back to the commit the issue's implementation
handoff recorded. That commit is resolved the same way, and where the repository does not hold it
or cannot be read it is left off the mark — the caller never sent it, so it is not refused — and the
answer and the audit comment name it and why.

What this replaced: sid-desk ISS-578's mark carried a real commit's first eight characters and a
fabricated tail, and nothing read it before it was recorded. That mark, like every mark that
predates this rule, reads `asserted` and names no commit: `merged_commit_sha` has held only a sha
GitHub gave since migration `0286`, which kept only values a merged pull request's sha starts with,
so no migration carries this rule backwards. The sha in such a mark's note is prose the
forge-plugin CLI reads; it sends the commit it marks at in the note and not as `data.commit`, so
until it does, this check sees only what reaches `data.commit`.

## What counts as landed depends on the issue's lane

`packages/core/src/issues/landing-evidence.ts` is the one answer, and every door that decides
whether a mark is enough calls it: the close gate (`refuseUnshippedClose`), the `merged_mark` entry
criterion, `RELEASE_WORK_UNMERGED` at both release doors (the record and, since ISS-1337, the batch
create, through `packages/core/src/release-batch/close-shortfall.ts`), the work-evidence gate and the
mark writer. The release batch's finish closes through the same transition, so it reads the same
answer.

An issue's lane (`laneOf`) is its own declaration where it holds one, else its project's kind. The
declaration is `issues.declared_landing_shape` (ISS-1384, migration `0320`): `git` or
`outside_git`, the column's CHECK refusing anything else, and NULL — every issue until somebody
writes one — answering the project's kind exactly as before. It exists for the git project's
change that lands no file in its repository, such as environment variables set on a deployment
and a redeploy: before it, that change reached `developed` only by a mark at the commit already
served, which says the change landed at a commit holding none of it.

- **Written** as `landingShape` on `PATCH /api/issues/:id` and on `forge_issues` `update`, by
  whoever may update the issue, an agent included; `null` hands the answer back to the project.
  It is never inferred from an empty diff, a missing branch or an absent handoff. A value outside
  the two shapes is refused by name at both doors, and `forge_issues` refuses `data.landingShape`
  on any action but `update` rather than dropping it.
- **Not while a mark stands.** A mark was judged on the lane it was made under, so a change to the
  declaration while `merged_at` is set is refused `LANDING_SHAPE_MARK_STANDS` (409), naming
  `unmark` as the route, and writes nothing. The condition is the UPDATE's own WHERE
  (`packages/core/src/issues/update-service.ts:shapeUnderNoMarkGuard`), so no mark lands between the decision and the
  write; the same value re-sent passes and writes nothing, `updated_at` included
  (`packages/core/src/issues/update-service.ts:declarationOnly`). On an issue that declared nothing the refusal says the
  project's shape applied, never that the issue declared null. A `closed` issue cannot be unmarked, so its lane is fixed.
  The other order is held too: the mark writer reads the declaration off the row its caller
  loaded, and `recordIssueMerge` stamps only while the issue still declares that value, so a
  declaration that moved in between is refused `LANDING_SHAPE_MOVED` with nothing written.
- **Read** as `landingShape` — the lane, the one field a client reads — on the REST detail and
  every `forge_issues` answer that serializes the issue whole, beside `declaredLandingShape`, the
  issue's own value or null. Every refusal names who decided (`whereItLands`): *this issue's work
  lands outside git (declared on the issue)*, or *this project's work lands outside git (kind
  `website`)*. A release roster, at the record door or the batch create, can now hold both lanes,
  so `RELEASE_WORK_UNMERGED` is raised once per lane, each in its own words, lanes and issues in
  the order the roster named them.

Where no issue declares one, `landingShapeOf` reads `projects.kind`: `website` — the store is the source of truth and a repo is
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

## Why a landing counts as work evidence outside git

On an `outside_git` lane `collectWorkEvidence` takes the landing a mark names as work evidence, and
the mark writer takes an agent's landing with nothing else behind it. The landing is free text
Forge does not read back from the resource it names: a claim, of the same weight as the branch
name an agent records in `sessionContext.branch`, which the gate has always taken unchecked. The
alternative left every agent-driven change on that lane with no route of its own to `developed`,
refused once at the mark and again at the status, and a git project's change that lands no file
borrowing a commit it did not make.

**What ends it:** a reader per landing kind — the deployment binding, the storefront, the URL —
that reads the landing back from where it names, the analogue of `readCommitLanding`; the mark
then counts only once that read agrees.

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
