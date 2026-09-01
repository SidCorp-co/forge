# The activity feed will call an agent's write a person's

**Status:** half shipped 2026-09-02. `activity_log.actor_agency` exists and the write paths fill
it. `kernel_transitions` does not have it, three writers still hand it a placeholder, and no read
path uses it yet — those are below.

`agency` separates a person from an agent at call time, and every lifecycle gate reads it. Until
this change nothing wrote it down: `activity_log.actor_type` stores `user | device` and nothing
else, so once a job token performs a write the row it leaves says `user` — true about ownership and
false about who typed it.

## What shipped

`activity_log.actor_agency` (`human | agent`, `NOT NULL DEFAULT 'human'`, migration
`0193_activity_actor_agency`). `pipeline/activity.ts:Actor` requires `agency`, so a writer cannot
omit it and silently record the default — the compiler names every site instead. `resolveActor`
reads it off the request context rather than inferring it from which principal matched, and
`requireAnyAuth` now carries it the way `requireAuth` does; it had been taking a principal that knew
the answer and keeping only `userId`, so every write behind it — attachment upload, comment post —
recorded a job token's work as its owner acting by hand.

## Where the column is a placeholder, not an answer

Each of these writes a value the code cannot currently justify. They carry a `cm:guard` saying so at
the call site.

| Site | What it writes | What it needs |
|---|---|---|
| `pipeline/outbox-worker.ts` | `agent` for a `device`/`system` row, `human` otherwise | `kernel_transitions_outbox` must carry agency; today the rebuild can only restate what `actor_type` already meant |
| `uploads/routes.ts` | `human` | the upload ticket authenticates the request and records no agency; carry it at mint time |
| `pipeline/missing-skill-resume.ts` | `human` | the resume payload records the user the paused run was filed under and nothing about the driver |

## Still open

- **`kernel_transitions` has no `actor_agency`.** Its enum (`user | system | runner | sweeper`)
  separates a sweeper from a person, which is why it was not the urgent half — but a job token
  transitions as `user` there exactly as it did in `activity_log`. Same column, different writer
  (`lifecycle/transition.ts`), different enum to reconcile.
- **No read path uses the column.** `issues/actor-resolution.ts` still computes
  `isAgent = type === 'device'`, and that is deliberate: every row written before 2026-09-02 is
  stamped `human` by the DEFAULT, runner writes included, so a feed wired to this column today
  would lose the agent marker on all of history. It becomes readable once the identification logic
  the owner deferred lands and decides what to do about the pre-column rows.

## Honest costs

Prices what shipped and what it leaves behind.

| Cost | Detail |
|---|---|
| The backfill is an owner decision, not a measurement | Every existing row reads `human`, including the device/runner writes that `actor_type` correctly calls agents. Decided by the owner on 2026-09-02: old data goes to `user`, agent identification gets its own change. The column is therefore a forward-looking record and says nothing true about the past |
| A third field two writers must keep in step | `actor_type` and `actor_agency` can disagree, and nothing type-checks that they do not. Requiring `agency` on `Actor` catches an omission; it cannot catch a wrong value |
| Three placeholder writers | Named above. Each is a value the code knows it cannot justify, which is worse than a gap only if nobody reads the guard beside it |
| The migration | `activity_log` is append-heavy; a column with a default rewrites nothing on modern Postgres. The journal `when` rule applied — drizzle stamped a real timestamp below the highest `created_at`, which would have skipped the migration silently and forever |
| The display change is still owed | `isAgent` drives the agent marker in the feed. Making it honest will move some rows from human to agent, which reads as a regression to anyone who does not know why — and cannot be done at all until the pre-column rows have an answer |
