# The record can lose an entry by never gaining one

Status: open decision, no code proposed
Found: 2026-09-02, backfilling the post-cutoff gaps in ISS-870

## What is wrong

Two gates stand between shipped work and the release record, and neither one faces the direction
this keeps failing in.

| Gate | Guards | Blind to |
|---|---|---|
| `RELEASE_RECORD_REQUIRED` (`packages/core/src/issues/release-record-required.ts`) | an **automated** close while `issues.release_notes` is null | a human close; whether the note ever reaches `CHANGELOG.md` |
| `no-silent-loss` (`scripts/check-release-record.mjs`) | an entry **present at the base revision** disappearing | an entry that was never written |

Its own header says as much: the refusal holds that something is written on the issue before it
closes, and "whether that line then reaches this file is the first half's job, not its own." Core
never reads `CHANGELOG.md`, and CI never reads the issue table, so no single process can currently
see both halves.

The measured consequence, over the 19 issues closed on this project between 2026-08-29 and
2026-08-31: two shipped with no line. ISS-877 satisfied the refusal — populated `releaseNotes`,
`section: 'Fixed'`, a critical fix to failure classification — and still reached no reader. ISS-854
closed with `releaseNotes` null and no line, because it was closed by hand and the refusal exempts
a human close by design (an operator making the claim deliberately owns it).

That exemption is right. The gap it leaves is that the manual close path offers **no prompt at
all** — nothing asks for the note, so owning the claim and forgetting the record are the same
gesture. Both issues here were owner-lane manual closes; no `drive` session was running at either
close timestamp. This is not a defect in the automated path.

## Why it is not fixed here

The two obvious fixes are both refused, for the same reason and one extra:

- **A CI gate that fails when a closed issue has `releaseNotes` and no matching bullet** would put a
  network call to the issue tracker inside the build. The repo cannot see Forge state and should
  not learn to.
- **Extending the refusal to human closes** changes a customer-visible default on the owner's own
  workflow, and would convert a deliberate gesture into a blocked one.

What is left is a prompt rather than a refusal — the close surface offering the release note, with
skipping it a visible choice — and that is a product decision about someone else's daily path, not
a repair.

## The decision

Does a manual close prompt for its release note, and if so, does the prompt also offer to write the
`CHANGELOG.md` bullet, or only the typed field?

Whoever answers should know the field alone is not sufficient: ISS-877 had it and still went
unrecorded.

## Honest costs

| Choice | What it takes |
|---|---|
| Prompt on manual close (field only) | one more step in the owner's fastest path; still leaves the file unwritten, which is the half that both measured gaps failed |
| Prompt on manual close (field + bullet) | the close surface gains a dependency on a git checkout it does not have today — the field lives in Postgres, the bullet in a repo the server never reads |
| Periodic reconcile instead of a prompt | the gap is found rather than prevented, one window late; this is what the scheduled review already does, and it is how both of these were found — the cost is that every instance needs a human to work an issue like ISS-870 |
| Leave it | the record stays a best-effort artifact. Each miss is cheap and recoverable; the accumulation is not, and the 1,034-line deletion showed how little anyone notices this file changing |
