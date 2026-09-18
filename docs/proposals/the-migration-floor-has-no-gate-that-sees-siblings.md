# The migration floor has no gate that can see a sibling branch

Status: open decision, no code proposed
Found: 2026-09-18, repairing ISS-1030's journal for the second time in two days

## What is wrong

`CLAUDE.md` states the invariant: a migration's `when` in
`packages/core/drizzle/migrations/meta/_journal.json` must exceed **every** `created_at` already in
the target database, because drizzle reads the single highest applied `created_at` once and skips
every lower entry silently and forever — the container starts, serves the new code, and the tables
do not exist. That is ISS-807, which presented as a live 500 on `GET /me/attention` for every
signed-in user.

The gate named against that invariant is
`packages/core/src/db/migrations-journal.test.ts`. It cannot enforce it, and CLAUDE.md says so:
it "reads only your own journal and so cannot see a sibling; the looking is yours." What is worth
writing down is how much weaker than that it actually is.

**Neither `when` assertion in it can see the failure even on a merged tree.** Measured on
ISS-1030's own branch: with `0269 @ 1799452800000` and `0270 @ 1799539200000` sitting below a
higher-idx `0272 @ 1799712000000` merged in from `main`, the journal still reads strictly
increasing in idx order, and the head entry is still a whole number of days above the previous
maximum. Both assertions go **green** on a tree carrying the defect. The only red anywhere was the
snapshot-chain assertion — and that fires on the renumbering, not on the `when`, so a branch whose
entries were renumbered correctly but dated below the floor is green on all five.

Proved against the migrator rather than the gate: a database taken to `max(created_at) =
1799712000000`, then run with each journal.

| journal | `src/db/migrate.ts` | tables |
|---|---|---|
| `0269`/`0270` below the floor | exit 1, `relation "backfill_markers" does not exist` | neither created |
| `0277`/`0278` above it | exit 0 | both created |

The exit 1 there is luck, not a gate: it comes from `runCanonicalBackfillOnce`, which happens to
touch one of the skipped tables. A branch whose migrations nothing else reads at startup gets a
clean exit 0 and a container serving new code on an old schema.

## Why the human protocol does not close it either

CLAUDE.md's answer is a reading: "Read every unmerged sibling's journal immediately before the
landing push and clear the highest `when` you find there." It is one-directional, and the direction
it does not face is the one that fired.

Measured on `origin` on 2026-09-18:

| branch | idx | `when` | pushed |
|---|---|---|---|
| `ISS-1026` (#498) | 275 | 1800057600000 | 02:04:31+07 |
| `ISS-1091-question-destination` (#500) | 276 | 1800316800000 | 04:12:28+07 |
| `ISS-1030` (#495) | 277, 278 | 1801180800000, 1801267200000 | 08:45:57+07 |
| `ISS-1069` (#482) | 279 | 1800576000000 | 08:48:54+07 |

Both runs followed the protocol. ISS-1030 read every sibling at its landing push and cleared the
highest by ten days. ISS-1069 pushed about three minutes later and did not clear ISS-1030, so its
higher-idx entry now sits seven days **below** it. Whichever of the two merges first buries the
other, and no gate on either branch can say so. The protocol is a read taken at a moment, against a
set that keeps moving; the last pusher carries a burden nothing tells it it has.

Nor is headroom a fix on its own. Generous headroom protects the branch that takes it and is
exactly what buries the sibling that took one step — the two pieces of advice in CLAUDE.md pull
against each other once more than one branch is open, and this repository routinely has four.

## The shape a check would have, and the shape it must not have

**The obvious formulation does not work, and it is worth writing down why before someone builds
it.** "For every entry this branch adds, assert its `when` exceeds the maximum across `origin/main`
and every other open branch's journal" is unsatisfiable the moment two branches each carry a
migration: A must exceed B and B must exceed A, so at least one is red, and repairing that one
turns the other red. Nor does a sibling merging release the deadlock — its `when` is then in
`origin/main`, which is still in the comparison. A symmetric sibling check is a mutually exclusive
ordering rule wearing a gate's clothes.

What can be gated is only the asymmetric half:

> For every journal entry this branch adds relative to its merge base, assert its `when` exceeds the
> maximum in **`origin/main`'s** journal.

That is sound, it deadlocks with nobody, it goes green on a real commit rather than on a rerun, and
it is exactly what would have caught both of ISS-1030's burials — each of which was `main` moving
under a branch, not a sibling racing it. A checker under `scripts/` rather than a vitest file,
because `origin/main` is not in the package.

The sibling-versus-sibling half **cannot** be a gate at all, and that is the finding rather than a
gap in the design. Which branch's migration may sit below which is decided by merge order, merge
order is not a property of any tree, and no assertion available to a branch can constrain it. It
needs serialization instead: land migration-bearing branches one at a time, and re-derive on each
rebase — or allocate `idx` and `when` from a registry outside the branches, so the numbers are
handed out rather than guessed. Both are process decisions and neither is a diff's to take.

Three things make even the asymmetric half a decision rather than a diff, which is why this is a
proposal and not a commit:

1. It is a **fourteenth gate**, so it lands in `scripts/verify.mjs`, in `.forge/conformance.json`
   under an axis, and in `ci-passed`'s `needs` and its result loop — the three places
   `scripts/README.md` says a gate must appear to hold. That is a change to the gate surface, which
   is nobody's to make inside an unrelated issue.
2. Its red is **not a property of the commit**. It goes red when `main` moves, against a tree that
   did not change. Clearing it always takes a real commit — the merge and the re-derive — so it
   never flips green on a rerun, but every contributor still learns that a green PR can go red
   while they are not looking. Every other check here answers for the tree it ran on.
3. It needs the **remote refs**, so it cannot run from `pnpm verify` on a shallow clone or offline,
   and a check that silently degrades to green where it cannot look is worse than none.

The interim is the prose in `packages/core/drizzle/migrations/README.md`, under "When a sibling
migration lands on `main` first", which now records both occurrences and the fact that a green in
`migrations-journal.test.ts` is not evidence about the floor. By the plugin's own rule a trap that
fires twice in prose has earned a check; this file is the statement of why the check was not
written here, and what it would have to be.

## Honest costs

What building the checker above takes from whoever adopts it, not what the bug costs today.

| Cost | What it means |
|---|---|
| A green PR can go red overnight | The gate reds when `main` moves, against a tree nobody touched. Clearing it costs a real merge and re-derive, so it never goes green on a rerun — but a long-lived branch now pays that toll every time a migration lands ahead of it, and this repository lands several a week. |
| Network and remote refs inside the gate | `pnpm verify` stops being answerable offline or on a shallow clone. Either it degrades to green where it cannot look — which is worse than no check — or it degrades to exit 2, and every contributor without full remote refs is held at a gate they cannot clear locally. |
| A fourteenth row in three files | `scripts/verify.mjs`, `.forge/conformance.json` and `ci-passed`'s `needs` plus its result loop. The conformance manifest gains an axis or an existing axis's level is re-argued, and `scripts/README.md` owes a row saying what the gate was born from. |
| It closes only half the hole, and the half it closes is the loud one | The sibling race is the half that cannot be gated at all. Shipping the `main`-only check and calling the problem solved is worse than shipping nothing, because the next burial will be a sibling's and nobody will be looking. Whoever adopts this owes the serialization or allocation decision in the same change, not after it. |
| Serialization has its own price | Landing migration-bearing branches one at a time makes migrations a queue with a single server, and on a wave of four open PRs that is real waiting. An allocator instead means a registry outside the branches that can itself go stale, and a number handed out to a branch that is later abandoned is a hole in the sequence forever. |
