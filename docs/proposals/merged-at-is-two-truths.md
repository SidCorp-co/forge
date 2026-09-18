# `merged_at` is two truths in one column

**Raised by:** ISS-1073, which made the merge and the stamp one operation and
then could not finish the sentence its own outcome 2 asks for.

## The outcome this does not meet

ISS-1073's second outcome reads: *"`merged_at` becomes evidence rather than
testimony: nothing can stamp it without the merge having happened, and a merge
cannot happen without it being stamped."*

The second half holds. `issues/merge-record.ts` is the one writer, the kernel's
merge writes through it in the transaction that records the landing, and a merge
a person makes reaches the same row through `pull_request.closed`. A commit sha
is evidence and only an observed merge writes one.

The first half does not. `merged-at.ts:markMergedOnClose` still stamps
`merged_at` on every close, on nobody's evidence, and `applyMergeMarker` still
stamps it on somebody's word.

## Why, and it is not that removing them was expensive

`merged_at` answers two questions with one value:

1. **Did this land?** The question ISS-1073 is about. Evidence answers it, and
   `merged_commit_sha` now carries that evidence.
2. **Is this settled enough to release its dependents?** The question
   `jobs/queued-gates.ts` asks. A closed issue that was never work — a note, a
   duplicate, a question — has to answer yes, or every dependent of it wedges
   with no event. That is the getcontent 2026-07-13 incident, and
   `markMergedOnClose`'s own header records what it cost.

Deleting the close stamp answers (1) by breaking (2). The two have to be
separated before either writer can go.

## What separating them costs

A column of its own for the settled truth, and a move of every reader of the
gate:

- `packages/core/src/jobs/queued-gates.ts` — the gate itself
- `packages/core/src/issues/dependency-read.ts`
- `packages/core/src/issues/entry-criteria.ts` — the `merged_mark` criterion
- `packages/core/src/issues/list-projection.ts`, `list-service.ts`
- `packages/core/src/issues/progress.ts` — its shipped-evidence partition
- `packages/core/src/me/pulse-quality.ts`
- `packages/core/src/memory/consolidation.ts`
- `packages/web-v2` wherever it renders a merged mark

And a backfill: every row already carrying a stamp has to be classified as one
or the other, and the only thing that can classify it is whether
`merged_commit_sha` is set — which is exactly the distinction this change
introduced, so the backfill gets cheaper the longer it waits and is wrong for
every row stamped before it.

## What ISS-1073 did instead, and what it bought

An asserted stamp is now PROVISIONAL. Evidence writes under
`merged_commit_sha IS NULL`, so a merge Forge later observes replaces a stamp
somebody asserted and takes the merge's own time; evidence already recorded is
never replaced. So the two truths are already distinguishable on the row:

- a stamp **with** a commit was observed;
- a stamp **without** one was asserted and nobody has observed a merge for it.

That is the whole of what the separation needs to read, which is why it is
cheaper to do now than it was before ISS-1073 and why nothing built there has to
be unpicked to do it.

## The second thing this unblocks

`entry-criteria.ts`'s `merged_mark` criterion tests `record.mergedAt == null`,
and its remedy sentence — published verbatim on every pull request since
ISS-1072 — says *"mark it merged, naming the commit it landed at"*. It asks for a
commit it does not read.

Tightening it to read `mergedCommitSha` is now possible and is deliberately not
in ISS-1073: it would fail every issue stamped before that change, and every
project with no GitHub binding, on a gate that refuses status writes. It belongs
with the backfill above, in the same change.

## Honest costs

| What it costs | Who pays it | When |
|---|---|---|
| A migration adding the second column, and a backfill classifying every existing stamp by whether it carries a commit | every deployment | at the deploy, once |
| Every row stamped before ISS-1073 is unclassifiable — it has no commit either way | any project older than this change | permanently; those rows have to be read as "settled", which is the safe direction and is also the wrong answer for the ones that really did land |
| Nine reader sites move at once, and the `blocks` gate is one of them | whoever takes it | in one change, because a half-moved gate dispatches against absent code, which is the failure this whole line of work exists to remove |
| `merged_mark`'s remedy sentence is published verbatim on pull requests since ISS-1072, so tightening the criterion changes a string contributors are reading | contributors on any project with the check on | at the deploy |
| Until it is taken, ISS-1073's outcome 2 is half met and this document is the record of which half | whoever reads the issue | now |

The thing that is NOT a cost: nothing built in ISS-1073 is unpicked by taking
this. The one writer, the two predicates and the evidence field are all what this
would build on.
