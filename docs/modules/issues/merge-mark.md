# The merged mark: what the two columns mean

`packages/core/src/issues/merge-record.ts` is the only writer of
`issues.merged_at` and `issues.merged_commit_sha` — `scripts/check-merged-at-writers.mjs`
holds that — and `mergeMarkKindOf` is the only reading of what the pair MEANS.

| `merged_at` | `merged_commit_sha` | kind |
|---|---|---|
| empty | — | `unmarked` |
| set | empty | `asserted` |
| set | a sha | `observed` |

`asserted` is not a half-written row. It is ISS-959's encoding for a merge nobody here
observed: somebody's claim that work shipped. `observed` is a merge Forge holds its own
record of. The two are as different as a receipt is from a promise, and until ISS-1126
the distinction lived only in the columns — every surface that wanted it had to re-derive
it from a null test, and none of them did. 851 of 851 marks on forge-dev are asserted and
nothing an agent read said so.

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

The caller's `data.commit` never reaches the column on either path — it reaches the audit
trail as the caller's claim. That is why the tool description states the condition the
column is written under rather than a blanket "always" or "never": both blankets have
been written into it and both were false.

Where the row already holds a stamp, the gated UPDATE moves nothing and the answer
describes what the row HOLDS, not which branch this call took. So the "your commit is not
what the column holds" clause compares the claim against the column. Comparing it against
the row the call happened to select tells a caller its own commit was overruled by that
same commit.

## Why the entry criterion accepts a claim

`entry-criteria-merge-mark.ts` gates `merged_mark` on membership of
`MARKS_ACCEPTED_AS_LANDED`, today `['asserted', 'observed']`.

That is an amnesty and this is its price. `observedMergeForIssue` needs a
`repo_pull_requests` row in state `merged`; until ISS-1123 (`9a78b0c93`) nothing but an
inbound webhook could write one, and no inbound delivery has ever been recorded on this
project's binding. Refusing asserted marks today would fail the criterion on every issue
the project has and stop every run.

**What ends it:** when observed marks are being written here — a pull request opened
through Forge and merged through the kernel door leaves a row and stamps the commit —
this set narrows to `['observed']`. Narrowing the constant is the whole change; the
criterion is gated on membership of it, so nothing else moves.

## Why the tests run at the route and at the handler

ISS-1126's criterion 14 names the surfaces of criteria 3 to 7: `POST|DELETE
/api/issues/:id/merge`, and `forge_issues`'s `get`, `list` and `mark_merged`. A test that
called `applyMergeMarker` or a serializer directly proves those helpers and nothing about
the runtime the criterion names — a route that dropped `mark` from its `c.json`, or a
handler that mapped every row through one reading, would stay green through it. So
`merge-mark-route.test.ts` mounts the Hono routes and `forge-issues-merge-mark.test.ts`
calls the tool factory's own handler. `merge-mark-surfaces.test.ts` keeps the helpers'
own property, which is a different claim.

The observed branch is only ever exercised under a mocked projection: on any database
here `repo_pull_requests` is empty, so the branch is unreachable in the field.
