# What ISS-1141 could not reach

ISS-1141 took the suite's teardown off the clock of the case it tears down for. The failure its own
body records is a different one, it did not recur in fourteen full runs, and it is not a new issue —
the rules refuse filing a residual as one. It is here so the next reader starts from evidence rather
than from the disproved hypothesis the filing opens with.

## Four assertions that have been seen once and never since

On 2026-09-21, two runs of an unchanged tree minutes apart disagreed, and the failing run reported
four assertion failures in two files — `github-merge-kernel-e2e.test.ts` and
`repo-projection-e2e.test.ts`. Both report an absent row:

```
AssertionError: expected { outcome: 'not-recorded', issueId: null }
                to match object { outcome: 'recorded', issueId: '3a1d1330-…' }
AssertionError: expected undefined to match object
                { state: 'open', merged_at: null, merge_commit_sha: null }
```

Fourteen full runs on 2026-09-27 at `9212778` and on the branch cut from it did not produce them:
four solo, two of them under `--sequence.shuffle.files`, and five concurrent pairs. A probe planted
on the exact branch that returns `not-recorded` never fired, in any of them.

## What is established, so nobody re-derives it

**File order is not the variable.** `scratch-db.ts:workerDbName` stamps every call
`test_w<pool-id>_<base36 time>_<random8>`, so the pool id is a name segment and not an allocation:
sampling `pg_database` across two concurrent suites returned 204 distinct such databases over three
pool ids. `isolate` is vitest's default `true`, so each file also holds its own process. Nothing one
file does reaches another file's rows or another file's module state, which is why the filing's
opening hypothesis — one database per worker, file-to-worker assignment deciding the answer — is
disproved rather than untested.

**The state those four report is one the writer says it does not produce.**
`projectOpenedPullRequest` returns `not-recorded` only when `applyPullRequestEvent` wrote zero rows
**and** the read-back found none. The statement was dumped and read: `INSERT … ON CONFLICT
("binding_id","number") DO UPDATE … WHERE false RETURNING "id"`, against the single unique index
`repo_pull_requests_binding_number_uq`. Zero writes there means a row for that pair existed — and
the read-back asks for that same pair, on the same connection pool, against the same database.
`opened-pull-request.ts` says so itself: *"a state this path does not otherwise produce."*

**So the residual is inside one file's own process and database**, not between files. The remaining
candidates worth a next run's time are a row committed and then removed inside that process, and a
`db` proxy resolving to a different instance from the one `projection.ts` holds — vitest's module
runner is known here to hand out two instances of one module when dynamic imports race
(`vitest-integration-vi-mock-concurrent-import` in project memory), and
`github-merge-kernel-e2e.test.ts` imports six modules in one `Promise.all`.

## Why it is not closed by ISS-1141's change

The issue's own first comment set the test and its reading: *"If the four in the body come back that
way, the two are one subject and the load fix is the fix. If only timeouts come back, they are two,
and this issue keeps the harder half."* Only timeouts came back. The teardown change removes those
and is measured against them alone; a green run under it is not evidence about the four above,
because no run anyone has taken produced them on demand.

## Honest costs

| Cost | To whom | Measured |
|---|---|---|
| A reproduction that may not exist at this head | whoever picks it up | 14 full runs on 2026-09-27 produced it 0 times |
| Both cheap conditions are already spent | the next run | a hostile file order is green; two concurrent suites now produce nothing |
| What is left is instrumentation carried across runs of unknown failure rate | the next run | a statement log on the writer's connection, and a check that `projection.ts` and `opened-pull-request.ts` hold one `db` instance |
| No red will ever remind anyone of it | the project | the teardown change removes the failures that do reproduce, so the suite reads green — which is what this looked like on every run but one |
