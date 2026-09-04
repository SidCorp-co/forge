# The `release` step: what core hands it, and what it owes back

ISS-897 made release a separate job over N `released` issues on a designated production runner. The
kernel half shipped with that issue; the agent half is the DISPATCHED PROMPT, not a skill —
`release-batch/prompt.ts` carries the whole protocol inline (roster, procedure, proof, rollback,
abort-or-finish) and the project's `release-procedure` fact carries the ritual. This file is the
contract between the two, written from the code that already exists rather than from an intention.

**Status:** live since 2026-09-03 (ISS-897). Sidpeak shipped 7 `release_batch` jobs that day with
no skill installed and none needed — two distinct `systemPromptHash` values, the prompt doing the
instructing. An earlier version of this line said "no skill implements this yet, so a batch release
dispatched today reaches a driver that does not know the protocol"; that was written from the
intention and it was wrong in effect, and on 2026-09-04 it was cited to tell an owner their batch
would wedge. Do NOT add a skill for this protocol: it would be a second live copy of the prompt.

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

## The three open questions

- **Batch atomicity.** If issue 3 of 5 fails its verification, are 1–2 closed? The kernel does not
  decide this; `finishReleaseBatch` takes the whole set. A human should pick before the skill is
  written, because both answers are defensible and the wrong one is only visible in an incident.
- **Who writes the changelog line.** `releaseNotes` is populated per issue and `forge-release`
  appends at close. Whether the batch writes one grouped entry or N lines is a formatting decision
  nobody has made.
- **Whether the roster may be incomplete.** Promotion is a merge of a BRANCH, so the unit that
  ships is the branch and not the roster the caller assembled. An issue whose `merged_at` points at
  the base branch, which is not `closed` and which nobody put in the batch, therefore ships anyway
  and stays open — released in fact and unreleased on the board. The same asymmetry reaches
  dependencies: a claimed issue whose `blocks` blocker is neither `closed` nor in this batch ships
  ahead of the thing it depends on. A `create` that refused both cases (`RELEASE_ROSTER_INCOMPLETE`,
  listing what it found) would close the gap, at the cost of a release that cannot be cut until the
  roster is reconciled. Nobody has chosen which side to take.

## Honest costs

Adopting this splits one agent's job in two, and the seam is where the price sits.

- **A project with production pays a second runner.** The release step is mandatory config
  (`releaseRunner`) beside the production binding, so a project that has production and no spare
  box cannot cut a release at all — its issues accumulate at `released` and nothing tells the owner
  except the count. The alternative (fall back to any runner) was rejected because a release
  procedure that runs on an arbitrary box is how a deploy reaches the wrong environment.
- **`released` is a real dwell state, and someone has to look at it.** Before this, `closed`
  followed the merge. Now an issue can sit merged-and-unreleased indefinitely, and every `blocks`
  dependent of it is already unblocked (`merged_at` is stamped at the merge) — so the backlog is
  invisible to the dispatcher by design. Nothing here builds the alarm for that.
- **The three open questions above are deferred onto whoever writes the skill.** Batch atomicity,
  the changelog shape and whether an incomplete roster is refusable are all decisions this document
  declines to make, which means the first implementation makes them by accident unless a human
  answers first.
- **The procedure is per project and unvalidated.** Core checks that `release-procedure` and
  `rollback` exist, never that they work. A project that declares a rollback it has not tested has
  bought the appearance of a way back, and obligation 5 cannot tell the difference.

## Every provider can be the production binding

`resolveReleaseChannel` reads the OLDEST active `prod` binding whatever its provider, and
`releaseRunnerLabel` / `verify` / `rollback` are read off `effectiveConfig` of that row. Until
2026-09-04 only `coolify` and `agent` spread `releaseChannelFields`, so on a project whose oldest
prod binding was any other provider the label PATCH returned 200 and stripped the field — the
release gate could not be declared at all. Measured on pixelight (epodsystem, storefront), where
`base === production` hid it behind the earlier refusal. Every provider schema now carries the three
keys and lists them binding-tier; `provider-schemas.test.ts` is table-driven over the six so a new
provider that omits them fails.

## Known residual: 8 issues the lane removal leaves behind

Measured on the live replica 2026-09-03. Migration `0195` moves every issue at `tested` to
`released` (76 across 9 projects). It does **not** move the 8 sitting at `testing`,
`developed`, `approved`, `confirmed` and `clarified` — mid-flight work under the deleted
lane, in projects ISS-897 does not own.

After the migration nothing dispatches them: only `open` reaches the driver. They render on
the board (`issue-vocabulary.ts` is total over the enum, deliberately) but no session will
pick them up.

Both automatic dispositions are worse than saying so. `open` fires 8 unrequested drive jobs
across other people's projects; `needs_info` writes a park with no reason and no comment,
which is a status move whose next reader cannot tell why. The disposition belongs to each
project's owner, who can move theirs to `open` when they want it driven.
