# The `release` step: what core hands it, and what it owes back

ISS-897 made release a separate job over N `released` issues on a designated production runner. The
kernel half shipped with that issue; the agent half is a skill in
`github.com/SidCorp-co/forge-plugin`, which this repo cannot gate. This file is the contract
between them, written from the code that already exists rather than from an intention.

**Status:** kernel side landed 2026-09-03 (ISS-897). No skill implements this yet, so a batch
release dispatched today reaches a driver that does not know the protocol. Writing that skill is
the work this file hands over.

## When a project has a release step at all

`release-batch/gate.ts:resolveProductionDeclaration` requires BOTH, and the AND is the rule:

| Half | Where it lives | Why alone is not enough |
|---|---|---|
| an active `prod` integration binding | `integration_bindings` | forge-dev carries two (sentry, epodsystem) on a trunk repo — observability, not a release target |
| `productionBranch !== baseBranch` | `projects` columns | a distinct branch with no binding is a project that has not finished declaring how it ships, and rule 3 puts the release runner ON that binding |

No declaration → `resolveReleaseGate` returns `null`, `issues/release-gate-hold.ts` stops rewriting
the driver's close, and issues go `open → … → closed` with no release step. That is the majority
case today.

## What core guarantees before the job dispatches

- Every issue in the batch is at `released`: merged to the base branch, run and verified on
  staging. `merged_at` is stamped.
- Every issue in the batch has a non-null `releaseNotes` — `createReleaseBatch` refuses the CLAIM
  otherwise (`RELEASE_RECORD_MISSING`), so the changelog line exists before the job starts.
- A release runner is designated. `service.ts` throws `RELEASE_RUNNER_UNDECLARED` rather than
  falling back to the fleet, so the job never lands on a box without the production credential.
- `release-batch/readiness.ts` has already reported any missing half to the settings screen, so an
  operator saw it before the first issue ran.

## What the skill owes

1. **Run the project's declared procedure**, from the `release-procedure` project fact. There is no
   floor and there must not be one — a floor written for one repo is what a release agent used to
   run against another.
2. **Verify production**, by the project's declared `verify` (`release-batch/channel.ts`). A deploy
   exit code is not verification.
3. **On success**, close every issue in the batch. Closing auto-stamps `merged_at`; that is correct
   here because the code did land.
4. **On failure**, roll back by the project's declared `rollback` and leave every issue at
   `released` — one comment naming what failed and what was rolled back.
5. **With no declared rollback, ABORT and comment.** Never a blind rollback: from inside one session
   an outage that predates the release is indistinguishable from one it caused, and a rollback
   deletes reviewed work while the outage survives it.

## The two open questions

- **Batch atomicity.** If issue 3 of 5 fails its verification, are 1–2 closed? The kernel does not
  decide this; `finishReleaseBatch` takes the whole set. A human should pick before the skill is
  written, because both answers are defensible and the wrong one is only visible in an incident.
- **Who writes the changelog line.** `releaseNotes` is populated per issue and `forge-release`
  appends at close. Whether the batch writes one grouped entry or N lines is a formatting decision
  nobody has made.
