# The activity feed will call an agent's write a person's

**Status:** open decision — the live gates are fixed, this half is not. Persisting a new actor
field is a migration on two enum columns and a human's call.

`agency` now separates a person from an agent at call time, and every lifecycle gate reads it.
Nothing writes it down. `issue_activity.actor_type` and `kernel_transitions.actor_type` store
`user | device` and nothing else, so once a job token performs a write, the row it leaves says
`user` — which is true about ownership and false about who typed it.

## What reads the stored column and gets it wrong

| Site | What it computes | What it will say about a job token's write |
|---|---|---|
| `issues/actor-resolution.ts` → `isAgent` | `type === 'device'` | `false` — an agent's write renders as the owner acting by hand |
| `issues/activity-routes.ts` | display identity from `(actorType, actorId)` | the owner's name and avatar, with no agent marker |
| `pipeline/outbox-worker.ts` | rebuilds an `Actor` from the stored enum | a `user` actor, so any future subscriber that gates on agency re-derives the wrong answer |

The first is the one that matters: `isAgent` is the field the UI uses to say "an agent did this",
and it is computed from the wrong axis. It was correct for as long as device-ness and agent-ness
were the same thing. They stopped being the same thing when a credential arrived that is held by an
agent and owned by a person.

## Why this was not fixed in the same change

The live gates needed no migration — agency is available on the principal at call time, so
`actorAgency` derives it per call and every existing caller keeps its exact behaviour. Persisting it
does not have that property: it is a new column on two tables, a backfill decision for every
existing row (they cannot be classified after the fact), and a display change. That is a different
change with a different risk, and doing it inside a security fix would have made the security fix
unreviewable.

## The decision

**Add `actor_agency` to both tables**, defaulted to the value implied today (`device` → agent,
`user` → human), and read it in `actor-resolution.ts` instead of deriving `isAgent`. Historical rows
keep the implied value, which is correct for every row except those the REST surface wrote for an
agent before `37b75937` — see the costs.

**Or accept the gap** and state it where `isAgent` is computed, so the next reader knows the flag
answers "came from a runner", not "was not a person".

The decision got easier on 2026-09-01: the backfill is not the guess this document first called it.
`device` meant agent and `user` meant human for every row in the table, by construction, with one
bounded exception named in the costs below. What the column buys is the FUTURE — the moment a job
token writes, `actor_type` stops answering the agency question and nothing else does.

Whoever decides should note when the gap widens: the moment job tokens start authenticating.
Measured on production 2026-09-01, zero have ever been minted, so there is time. That is not the
same as saying the table is clean — the REST window in the costs below already holds rows an
agent wrote under a `user` label, and no backfill can find them.

## Honest costs

Prices the fix (the new column), not the gap.

| Cost | Detail |
|---|---|
| A migration on two hot tables | `issue_activity` and `kernel_transitions` are append-heavy; adding a column with a default rewrites nothing on modern Postgres, but the journal `when` rule still applies and a wrong value there skips the migration silently and forever |
| The backfill is right for every row but one narrow population | Measured 2026-09-01: `actor_type` and agency coincided for the whole history. A device token stores `device`; the chat surface stores `device` too, because `chat/tools/principal.ts` hands `principalActor` a stub device; an MCP human PAT and a browser session both store `user`; and no job token has ever been minted. The exception is REST: until `37b75937` it built `{type:'user'}` for every caller, so an agent holding a human PAT wrote rows labelled `user`. That window opened only when `forge-runner api` shipped, and rows inside it cannot be re-classified — nothing recorded the credential |
| A third field two writers must keep in step | `actor_type` and `actor_agency` can disagree, and nothing type-checks that they do not; the failure is a feed that labels writes wrongly, which nobody reports because it looks plausible |
| The UI change is not free | `isAgent` currently drives an agent marker; making it honest means some rows that render as human today start rendering as agent, which reads as a regression to anyone who does not know why |
| Doing nothing has a cost too | The first job token's writes will be attributed to the person who queued them, in the one view a human uses to audit what an agent did |
