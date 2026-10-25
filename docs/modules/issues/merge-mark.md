# The merged mark: what the two columns mean

`packages/core/src/issues/merge-record.ts` is the only writer of
`issues.merged_at`, `issues.merged_commit_sha` and `issues.merged_landing` —
`scripts/check-merged-at-writers.mjs` holds that — and `mergeMarkKindOf` is the only reading of
what the columns MEAN.

| `merged_at` | `merged_commit_sha` | `merged_landing` | kind |
|---|---|---|---|
| empty | — | — | `unmarked` |
| set | empty | empty | `asserted` (the commit an agent named, where Forge could not check it, in `merged_claimed_commit`) |
| set | empty | text | `landed` |
| set | a sha, `merged_commit_stated` false | — | `observed` |
| set | a sha, `merged_commit_stated` true | — | `asserted` (a commit a person named, which the repository holds) |

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

`applyMergeMarker` looks for the issue's most recently merged pull request Forge has projected
(`observedMergeForIssue`). Where it finds one it stamps `merged_at` AND
`merged_commit_sha`, from that record. Where it finds none it stamps `merged_at` alone. A row
that already holds a commit is moved forward by a later one, never overwritten (below).

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
date, and the mark reads `observed`. Every answer from a repository Forge READ that says no is a
refusal by name and writes nothing: `COMMIT_NOT_IN_REPOSITORY`, `COMMIT_NOT_THIS_ISSUE`,
`COMMIT_NOT_LANDED`. Where Forge cannot tell (the project declares no way to read its repository,
the reader it has fails, or no base branch is named) the agent's commit is kept as a claim instead
(below, ISS-1409), and `COMMIT_UNVERIFIED` is what a person's mark, or an agent's on an issue that
already holds a branch, meets there. On the git route the cause is one of five. The first is that the name of the
host the URL names did not resolve, which is found before any connection is made
(`packages/core/src/git/bounded-fetch.ts:unresolvedHostRefusal`). The other four are read from
what the host said (`packages/core/src/git/bounded-fetch.ts:hostRefusal`): the host refused the key;
it took the key but will not let it read that repository, or none is there; the host could not be
reached; or the repository lacks a branch. Each of the first four says what clears it, and where that
is access for the key it asks for read access, as Test connection under Git access does, which is
all Forge needs, and says that devices pushing with the same key need write access. That is at most three short sentences with no dash, and the host's
own line, past any `remote:` banner, stands apart beneath them (`Refused.said`, put on its own line by
`packages/core/src/projects/repository-reader.ts:saying`).
What clears it is named beside the cause, in the answer to an agent's mark (the claim's) and in the
refusal to a person's: mark again once the tracker can read the repository: through the GitHub binding where the project has one, otherwise with the deploy key
over the SSH clone URL under Git access; where a branch is missing, once the repository has it or
the project's base branch and release chain name only branches it has; and where the project names
no base branch, once it does. A project with no binding is told to bind GitHub only beside the key,
and only for a github.com remote. A person's mark naming a commit is checked against the same
repository (below). GitHub
answers an abbreviated sha that no commit starts with and one that
several commits start with alike, and git resolves a prefix only against the commits its branches
hold, so on either route such a sha is refused `COMMIT_NOT_IN_REPOSITORY` as
unresolved, asking for the full sha, and never reported as absent. A full sha no branch holds is
fetched by itself on the git route, and the host serving no such commit is the absent answer. On
the GitHub route the absent answer is HTTP 422, which GitHub gives for a commit a repository it
shows does not hold; HTTP 404 is its answer for a repository the installation cannot see (removed
from the App's repositories, renamed or deleted), so a 404 is the repository unreadable — it names
the repository and asks for it to be restored to the installation — and never a commit absent
(`packages/core/src/integrations/github/repository-reader.ts:githubRepositoryReader`). A
name longer than a whole sha (40 hex digits in a SHA-1 repository, which is every GitHub one) is no
commit's sha and no prefix of one, yet git, once the commit is packed, and GitHub both answer it by
its first 40 digits. So each reader refuses it `COMMIT_NOT_IN_REPOSITORY` by its length before the
host is asked, naming how many digits it has
(`packages/core/src/projects/repository-reader.ts:overlongCommitName`).

## Where Forge cannot verify the commit (ISS-1409)

`COMMIT_UNVERIFIED` is the refusal a person's mark meets where the repository could not be read.
An agent's mark is not refused there. Wherever Forge cannot tell whether the commit is this issue's
landing — the project declares no way to read its repository (no GitHub binding, and no deploy key
beside a repository URL: `RepositoryAccess` answers `refused` with `unbound: true`), a reader it
has fails (a GitHub read or token-mint failure, a host that refuses the key or cannot be reached, a
missing branch, a repository URL that is no SSH remote, no vault, an undecryptable key), or the
project names no base branch — a project that works with Forge purely through the CLI and API, or
whose deploy key is attached wrongly, could never finish an issue whose work landed on the base
branch. The missing or broken connection is a configuration Forge lacks, not evidence the work is
false (owner ruling, 2026-10-08), so the agent's mark is **accepted**, as the `asserted` kind (the
columns above, unchanged) and with the commit it named kept in `issues.merged_claimed_commit`.
`readCommitLanding` passes every one of these up as `unreadable` (`why`, what `clears` it, and
whether it is `noReader`); a repository that was read and says no never carries it.

- **It is a claim and says so.** `merged_commit_sha` stays empty, so `mergeMarkKindOf` reads
  `asserted` and every surface that shows merges — the rail, `forge issue`, live reach, release
  weighing — reads it as one: live reach and the weighing take `merged_commit_sha`, never the
  claim, and a project with no reader gives live reach `unmeasured` carrying the reading's own
  reason (`liveReachOf` over a `refused` reading), never `not_on_live` or `none_waiting`. The mark's answer, its
  audit comment (both `describeMergeMark`'s one sentence) and `mergedClaimedCommit` on every issue
  row say the commit was NOT verified and name once what would verify it. With no reader that is the
  deploy key under Settings → Runners → Git access, or a GitHub binding; with a reader that fails
  or no base branch, the cause in the host's own words and the setting that fixes it, so a broken
  key stays visible on every mark it touches.
- **It is work evidence.** `collectWorkEvidence` counts a standing claim like a recorded branch,
  so the issue reaches `developed` and `testing` for an agent. A person's bare mark, which names no
  commit, is still not evidence; an agent's claim may be attached to it (`recordIssueMerge`'s
  `unverifiedCommit` gate), where it would otherwise be refused and dropped.
- **Only "cannot verify" is softened.** A repository that was READ and says no (the commit absent,
  another issue's, not on the base or live branch) is refused as before, by name, and nothing is
  written. A person's mark naming a commit, and an agent's naming one on an issue that already
  holds a branch, still go through `resolveMarkCommit` and are refused
  `COMMIT_UNVERIFIED` where nothing can read, on an issue not yet marked; only that refusal offers
  a mark naming no commit. On an issue already marked the call writes nothing and is answered, in
  its reply and its comment, with where the mark stays, the reason quoted (ISS-1421 r8).
- **It is verified later by a repeat mark.** With a claim standing, `agentEvidence` reads the
  repository for the commit the repeat names, or the claim, before it takes the claim as evidence.
  Readable and agreeing: the one writer's observed stamp, whose gate is the empty
  `merged_commit_sha`, writes the full sha, replaces `merged_at` with the commit's own date and
  clears the claim in the same statement; the issue may be `closed`. Readable and contradicting:
  refused by name, the unverified mark untouched. Still nothing to read, or a reader that still
  fails: answered `already_merged`, still unverified, naming the cause. A repeat naming a commit other than the claim
  that stands is answered the same way and says by name that the commit it named was not recorded,
  the first claim being the one kept (`describeMergeMark`'s `notKept`); an abbreviation of the
  standing claim is the same commit and says nothing. No sweep does this on its own; a second place
  deciding what a mark means is the defect this file opens with. `unmark` clears the claim with the
  mark, and the table's CHECK holds a claim beside a mark and never beside a commit.
- **The automatic release is not softened.** It reads the judged commit against production, not the
  merge columns, and keeps its hold where it cannot read; a release a person presses with named
  issues never made this check.

Where the caller names a `landing` and no merged pull request exists, it stamps `merged_at` AND
`merged_landing`. On every path but the one above, the caller's `data.commit` never reaches the
column — it reaches the audit trail as the caller's claim (and, where Forge cannot verify it,
`merged_claimed_commit`, above). That is why the tool description
states the condition the column is written under rather than a blanket "always" or "never":
both blankets have been written into it and both were false.

A merged commit on the row is work evidence: `collectWorkEvidence` reads `merged_commit_sha`
where `merged_at` is set, so an issue the mark accepted is not refused `NO_WORK_EVIDENCE` at
`developed` or `testing` one status later. The `NO_WORK_EVIDENCE` refusal
(`packages/core/src/pipeline/work-evidence.ts:noWorkEvidenceDetail`) offers that commit route
on the `git` lane only, and to an agent only. At the doors that move a status it also tells that
lane how an issue whose change lands no file in the repository declares itself `outside_git`; a
mark's own refusal is its three sentences alone, with none of the lane's rules appended (ISS-1421 r10).

On an `outside_git` lane the landing a mark names is the work evidence (ISS-1384):
`collectWorkEvidence` reads `merged_landing` where `merged_at` is set and the lane is
`outside_git`, and an agent's `mark_merged` carrying `data.landing` is let through with nothing
else behind it, because the landing IS the trace such work leaves. The refusal on that lane names
the landing route and never `data.commit`. Its price is below.

The `work_evidence` entry criterion runs the same check and holds a person as well, so its refusal
is the `criterion` door's (`EvidenceDoor`): it names the branch route, says a person's mark
naming a commit is checked only for the repository holding it, not read as this issue's landing, so
it does not clear it, and names `statusEntryCriteria` as the
declaration to change where the project's work leaves none of these.

Where the row already holds a stamp and the call names no later landing (below), the gated
UPDATE moves nothing and the answer describes what the row HOLDS, not which branch this call took. Both the answer and the thread
comment open by saying so — "Already marked merged on 17 Oct 2026, so this call changed
nothing." — with the caller's note whole on a line of its own and never the "Marked merged" a
first mark opens with (`packages/core/src/issues/merge-marker.ts:alreadyMarkedSentence`). An `unmark`
on a row holding no mark is refused `NOT_MARKED_MERGED` and writes no comment: `clearIssueMerge`
takes only a marked row, so a removal never reaches the record that did not happen. So the "your commit is not
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

## A later landing moves the mark forward (ISS-1421 round 7)

An issue worked in rounds merges more than once, and the mark is where it landed: the release
gate, the roster, live reach and the issue's properties all read `merged_commit_sha`. Until round 7
the observed write was gated on an empty column and `observedMergeForIssue` read the OLDEST merged
pull request, so the first round held the mark for ever and every later one was answered "changed
nothing"; ISS-1421 read its first round's commit after three more had merged.

`packages/core/src/issues/landing-advance.ts` reads a candidate commit against the one the row
holds through the project's repository (`RepositoryReader.descends`: one GitHub compare's status,
or `merge-base --is-ancestor` over the deploy key's fetch). The candidate is the commit a mark
names, read as this issue's landing by `readCommitLanding` (a person's included), or, where the
mark names none, the most recently merged pull request's merge commit; an older merged pull
request is not read.

- **It descends:** the mark moves to it, commit and time, and the comment and the answer say "The
  landing moved from commit A to commit B, which carries it." The answer's `movedFrom` names A.
  The write names A as the commit it moves from (`recordIssueMerge`'s `supersedes`) and lands only
  while the column still holds A; a write that loses that race reads the row again and compares
  again, at most three times, and only a write that took is reported as a move.
- **The same commit, or one A already carries:** nothing changes, answered as any repeat, with
  "Commit B is already in commit A, where the mark stays." where they differ.
- **Neither:** a different landing. The mark door refuses it `LANDING_NOT_DESCENDANT`, naming both
  commits and Unmark then Mark merged as the way to move it there, and writes nothing.
- **The repository cannot say:** the mark stays, answered as a repeat naming why. Like an agent's
  unverified claim (ISS-1409), a read Forge could not take is not evidence the work is false.

A merge Forge observes itself takes the same reading: GitHub's `pull_request` event
(`packages/core/src/integrations/github/projection-events.ts:stampMergedIssue`) and Forge's own merge
(`packages/core/src/integrations/github/merge.ts:writeEvidence`), both through `stampObservedMerge`
and `advanceObservedLanding`. Nobody is there to refuse, so a merge that does not descend, or that
could not be compared, is left with a comment on the issue saying so, once; a redelivery of a merge
the mark already holds says nothing.

What does not move: an unverified claim (`merged_claimed_commit`), since no read could place it on
a line, and a `landed` mark outside git, which has no commit. No stored row was rewritten: a mark
left at an earlier round moves on that issue's next mark or next observed merge.

## How a mark answers a person (ISS-1421)

Every human sentence a mark gives — the answer's `detail`, the toast, the audit comment, a refusal's
message — names a commit by its first seven characters (`packages/core/src/issues/merge-record.ts:shortCommit`; a
`MergeMarkerError` shortens any whole sha in its message). The whole sha stays where a caller reads
it as data: the row (`mergedCommitSha`, `mergedClaimedCommit`), the answer's `movedFrom` and
`namedCommit` (the commit this mark named where no column keeps it), a refusal's `details`, and the
rail's hover, where an observed commit and a claim's both show by seven characters. An answer is at
most three short sentences of Forge's own: what happened, why in one clause, what to do, each
capitalised, stopped and at most 20 words. Another part of Forge's reason — a host's refusal —
stands quoted on a line of its own beneath them (`withReason`), opened capitalised unless it opens on
an address and stopped where it was not, never cut into one of them; the host's own line under it is
quoted whole as code, one piece (`quotedRefusal`), as the releasing sweep's comment quotes it too; a commit's subject is quoted
there as the commit holds it, unstopped. A repository holding no commit is named in the sentence
itself, so its reader's own words are quoted only where they say more (an overlong sha). A toast keeps
the quoted reason to its first clause on a line of its own, the mark's comment holding it whole
(`packages/web-v2/src/features/issues/hooks.ts:answerInBrief`), and a refusal shown beside the form,
which writes no comment, puts it whole on a line of its own, the host's line as it said it
(`packages/web-v2/src/features/issues/hooks.ts:answerShown`). A first mark's toast reads "Marked
merged." over one sentence saying whether Forge saw the merge or the mark is a claim, as the comment
does, a claim in the comment's own words (`packages/contracts/src/mark-merged-words.ts:markIsSentence`). A first mark's comment names its commit once: the label carries it only where the sentence
after it does not, and a repository's address shows there as code, never a mail link, a bare
`user@host` in a quoted host reason included (`addressesAsCode`). A note, on a first mark, an unmark
or a repeat, is quoted on a line of its own (`threadBody`). Each mark refusal names the field its
own door's caller sends: `landing`, `commit` or `target` on REST, `data.landing`, `data.commit` or
`data.target` on MCP (`packages/core/src/issues/landing-evidence.ts:markField`), and the page's
own field on the issue page (`packages/web-v2/src/lib/api/error.ts:formatApiError`). Either
door's refusal of its own input, a blank target read as a missing one, is one sentence naming what
the mark needs (`packages/core/src/issues/merge-input-refusal.ts:markInputRefusal`), with zod's
account kept in `details` on REST; on MCP, a `mark_merged` or `unmark` its input schema refuses (a
blank, all-spaces or unknown `data.target` among them) is worded the same way before zod's text
reaches the caller (`packages/core/src/issues/merge-input-refusal.ts:refusedAsMark`). An MCP `target` of `base`, `prod` or `feature` is written as the branch it
means (`packages/core/src/issues/mark-target.ts:markTargetBranch`). No answer repeats "Forge saw
this merge land" before the point; `packages/core/src/issues/mark-words.test.ts` holds every
sentence builder to this.

## Every `git` mark's commit is one the repository holds

A claim is still checked (ISS-1350). On a `git` project every commit a mark records — a person's,
an agent's on an issue that has a branch, one beside a merged pull request — is first
resolved by the project's repository (`packages/core/src/issues/commit-landing.ts:resolveMarkCommit`, the same commit
read `readCommitLanding` takes). The repository holding no such commit refuses the mark
`COMMIT_NOT_IN_REPOSITORY`; a repository that cannot be read refuses it `COMMIT_UNVERIFIED` on an
issue not yet marked, naming why, and a mark naming no commit is the route that still records. A
resolved commit is named by the full sha the repository gives, never as the caller typed it. The
one commit not read is the merged pull request's own merge sha, which Forge already holds.

A person's mark carries the commit that landed (ISS-1300 round 3). Where Forge holds no landing
that resolves — no commit on the row and no merged pull request, or one the repository was read and
lacks — the commit a person names, once the repository resolves it, is stamped in
`merged_commit_sha` with `merged_commit_stated` set, replacing a held commit the repository lacks
(`packages/core/src/issues/merge-marker.ts:statedLanding`). It is the commit everything reading the
landing reads, the weighing included, ahead of the landing head a run captured and of a pull
request's merge commit the repository lacks. The mark reads `asserted`: Forge read that the
repository holds the commit, not that it is this issue's landing, so the answer says the commit "is
recorded as where this work landed" and that the mark is a claim, and the rail shows it as claimed
and in the repository. It is no work evidence
(`packages/core/src/pipeline/work-evidence.ts:collectWorkEvidence`), as it was not before. A landing Forge
holds that does resolve, or that the repository could not be read for, keeps the rules above and
below: a person's other commit is read as a later landing, and an agent's commit is never stated. A
later merge Forge observes moves a stated commit forward like any other and clears the flag.

Where the caller names no commit, the mark records none. No step handoff is read for one: the
work-evidence gate reads the issue's own row and nothing else (`packages/core/src/pipeline/work-evidence.ts:collectWorkEvidence`),
so a commit a handoff recorded is neither evidence nor a mark's commit.

What this replaced: sid-desk ISS-578's mark carried a real commit's first eight characters and a
fabricated tail, and nothing read it before it was recorded. That mark, like every mark that
predates this rule, reads `asserted` and names no commit: `merged_commit_sha` has held only a sha
GitHub gave since migration `0286`, which kept only values a merged pull request's sha starts with,
so no migration carries this rule backwards. The sha in such a mark's note is prose the
forge-plugin CLI reads; it sends the commit it marks at in the note and not as `data.commit`, so
until it does, this check sees only what reaches `data.commit`.

## A recorded commit the repository does not hold, when verdicts are weighed (ISS-1300)

The write side above keeps a commit the repository lacks out of `merged_commit_sha`. The read side
does not trust that alone: a value can predate the rule, the project's repository can be rebound or
rewritten, and a verdict's source is also weighed against the landing head a run captured
(`packages/core/src/issues/verdict-standing.ts:issueIdentities`, the merge's commit first), which
no mark writer checks. So where a source verdict is weighed against that recorded commit — only
where nothing reads what the project serves, a served commit answering a source verdict first —
the weighing asks the repository once whether it holds it
(`packages/core/src/release-batch/runtime-weighing.ts:readWeighingNow`, through the same reader
the carriage takes; a commit found is trusted for an hour, since a rewrite can take it away, and
one absent is asked again on the next weighing).

A repository that was read and holds no such commit anchors no verdict: each criterion it holds
back carries one sentence word for word, naming the commit, the repository and the record to
correct, whatever commit each verdict names, the same commit included
(`packages/core/src/issues/verdict-standing.ts:unresolvedSentence`). The criteria report carries it
once as `unresolvedLanding`, with `from` saying whether it came from the merge mark or the landing
record, and the automatic release's hold leads with it and names correcting that record, never a
verdict on each criterion (`packages/core/src/pipeline/release-hold-kinds.ts:criteriaHold`). The
act is a person's on the issue page: Mark a later merge, or Mark merged on an issue not yet marked,
naming the commit that landed under Commit, which the panel offers on every mark in git. That
commit is stamped as above and replaces the one the repository lacks, so the next weighing reads
it and the hold is gone. The release readiness page and the release-create refusal give the same
act for that issue in place of the criteria it would owe, all three from
`packages/core/src/issues/landing-correction.ts:landingCorrection`.

Absent means the repository was read and answered that it holds no such commit: on the GitHub
route an HTTP 422, never the 404 GitHub gives for a repository the installation cannot see. A
repository that could not be read — that 404, a 401 or 403, a failed token mint, or a request that
never reached the host — names nothing absent: the verdicts are weighed against the recorded commit
as before, and stay held by equality. Where the project binds a repository and it refused the
read, each held verdict says so beside its reason, and the hold, the release readiness page and the
release-create refusal say Forge cannot read that repository and what restores it, through the
same remedy as any failed repository read
(`packages/core/src/issues/landing-correction.ts:unreadLandingClears`). A project that binds no
repository is not told to bind one here.

The forge-plugin CLI's own check of a verdict against the merged commit reads that commit out of
the mark's note, not off these columns, so it is not covered here.

## What counts as landed depends on the issue's lane

`packages/core/src/issues/landing-evidence.ts` is the one answer, and every door that decides
whether a mark is enough calls it: the close gate (`refuseUnshippedClose`), the `merged_mark` entry
criterion, `RELEASE_WORK_UNMERGED` at both release doors (the record and, since ISS-1337, the batch
create, through `packages/core/src/release-batch/close-shortfall.ts`), the work-evidence gate and the
mark writer. The release batch's finish closes through the same transition, so it reads the same
answer.

A project whose release chain names a `tag` owes a close one more thing, asked after the mark is
accepted: a tag matching that pattern contains the commit the work landed as
(`packages/core/src/issues/release-tag-close.ts:holdReleaseTagClose`, ADR 0004). It reads the
landing commit this page calls `observed` or, where only a claim stands, the claimed commit.

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
