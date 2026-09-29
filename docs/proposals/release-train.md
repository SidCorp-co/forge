# The release train: the system proof is batched, a change's own proof is not

A **release train** is a set of changes that share one payment of the expensive, whole-product half
of proving. It forms at `developed`, it is cut by whichever of two triggers fires first, and its
members land individually.

This page exists because the logic was settled and then could not be found. On 2026-09-29 a
dispatcher looked for prior work on exactly this idea, did not find it, designed it again from
scratch, and wrote a second knowledge entry under a third name. The entry it failed to find had
been `verified` for two days and carried measurements the redesign did not have. **The names below
are therefore part of the deliverable, not decoration.**

## Where this is already written down

| What | Where | Holds |
|---|---|---|
| The rule, with the measurements | knowledge entry `a-release-train-batches-the-system-proof-not-a-changes-own-proof` | the figures, the config keys, the preconditions |
| The merge-queue half | ISS-1203 | `N^2/2` landings under `strict: true`, attribution, Uber SubmitQueue prior art |
| A local role written during the rediscovery | `.claude/skills/forge-integrator/` | the operating procedure, not the economics |
| A duplicate entry from the rediscovery | knowledge entry `release-cohort` | nothing the first entry does not, under a name retired everywhere else |

`release-cohort` is a duplicate and is to be folded into the first entry and removed. The word
`cohort` was replaced by `window` in the role's own text while that entry kept it, so the slug now
contradicts every other surface.

## The number that makes it worth doing

Measured on this project's run corpus, 379 runs over 2026-09-20 to 2026-09-27:

- phase 4 Implement — median **7.3 min**
- phase 5 Prove — median **43.4 min**

Proving costs **5.95x** what building costs, per change.

That ratio is a measurement. What follows from it is a **hypothesis a train trial has to settle**,
not a conclusion: that amortising the proof buys more throughput than speeding the builder up.
Durations alone cannot establish it, because the answer also depends on how much proving runs in
parallel, how much of the proof actually divides — the section below shows part of it does not —
and how much either side could be reduced at all. With enough parallel proving capacity, building
becomes the bottleneck despite being the shorter phase.

The source entry states this more strongly, as a fixed return ratio on engineering effort. That
claim does not follow from the measurement and should be corrected there too.

## The split that makes it safe

A developer tests within the feature they built, not across the whole product. "Prove" splits the
same way, and the whole design rests on this line:

- **Scoped proof** — the change's own criteria, its unit and scoped tests, the review of its diff.
  **Paid per change.** Cheap, and it is what keeps a failure attributable.
- **System proof** — e2e, integration, QA against the running product. **Paid once per train.**
  Expensive, and it does not grow with the number of changes in front of it.

**The train batches the second only.** Batching the first would be dropping proof — a different
act wearing the same word.

## Why the second one divides

Time inside Prove, summed across 113 runs: `read 936m`, `codex whole-set 521m`, `wait 446m`,
`test 442m`.

`test` and `wait` are the fixed parts: running the integration suite over ten changes costs about
what it costs over one. `read` is partly fixed. `codex whole-set` grows with the diff and does not
divide. So batching N changes divides the fixed part by N and leaves the rest alone.

```
ten changes, one at a time    10 x (7.3 + 43.4)  = 507 min
ten changes, one train        10 x 7.3  +  43.4  = 116 min
```

**116 is a floor the real figure sits above**, because `codex whole-set` is in the batch and does
not divide. The only honest way to learn the real number is to run a train and measure it.

## The shape

```
  developed ──┬── ISS-a ──┐
              ├── ISS-b ──┤
              ├── ISS-c ──┼──▶ [ system proof, paid once ] ──┬─ green → land each member on its own
              ├── ISS-d ──┤                                  │
              └── ISS-e ──┘                                  └─ red   → NAME the member, split it
                                                                        out, revalidate the rest
```

Green does not buy one commit. It buys one validation window, and the members land individually so
a revert still names one change.

Red is never reported as "the train is red". The declared policy is `redBatch:
attribute-then-split`, and the train inherits it.

## The config, and why each key

Held in the plugin's per-project JSON, beside `shape`, `release`, `redBatch` and `rank`:

```json
"train": { "at": "developed", "minutes": 90, "size": 5, "maxSize": 10 }
```

- **`at`** — the rung the train forms at. `developed` is the only rung where the 43 minutes is
  still unspent; a train forming at `awaiting_release` batches the deploy alone and saves minutes,
  not hours.
- **`minutes`** — cut when the oldest member has waited this long, so a member never waits
  unboundedly for an Nth that may never arrive.
- **`size`** — cut when this many are aboard.
- **`maxSize`** — a hard ceiling, so a busy hour cannot assemble a train too large to attribute.

Unset means today's behaviour, unchanged. Both triggers are needed and fire on whichever comes
first — the shape every batcher converges on, from Kafka's `batch.size` plus `linger.ms` to a merge
queue's group size plus its wait.

**No value for `minutes` or `size` is derivable from this project's data today.** `forge stats
waves` reports nine waves of which eight have a single member, and its per-wave figures are the
session's totals repeated on every row, so it cannot answer the question it names. Start small,
record pass and fail per train, and raise `size` as the measured pass rate allows.

## What the train is NOT

**It is not the merge queue.** ISS-1203 measures a different cost: landing N green PRs costs
roughly `N^2/2` validation cycles under `strict: true`, because each landing puts every other PR
behind and each must then be brought up to date, re-read and re-gated. That is a *merge* problem.
The train is a *proving* problem. They meet at the same batch and they are not the same saving,
so a change that implements one has not implemented the other.

**It is not what `forge next` already batches.** That proposes batches by **file overlap**, a
build-stage criterion for avoiding merge conflicts, and it keeps a batch below the top rung. The
train's criterion is amortising a fixed cost: it wants as many members as attribution can carry and
does not care whether they touch the same files. One word `batch` is doing two jobs whose optimal
sizes point in opposite directions.

**It is not a reason to skip a change's own gate.** A change joins at `developed` already green at
its own head.

## Two things that must be true before `size` is raised

1. **A batched brief must not lose an issue.** The worktree `judge-b1-b` carried ISS-1162 and
   ISS-1286; ISS-1162 came back with verdicts and ISS-1286 with none, the brief having read as the
   other issue's only. Seen twice on 2026-09-27 and reported to forge-plugin. Raising `size` while
   this stands multiplies the issues silently dropped by `size`. ISS-1286 was still stuck at
   `developed` on 2026-09-29 as a direct consequence.
2. **Attribution must be demonstrated, not assumed.** `redBatch: attribute-then-split` is a
   declared policy, not a measurement. Plant a train with one deliberately broken member and watch
   it name that member before trusting it with real work.

## What already exists, so nothing here is greenfield

`forge brief --batch`; batch branches (`-b1`, `-b2`) merged into an `integration/batch-N`; judges
dispatched over more than one issue; `redBatch: attribute-then-split` as the plugin default;
`rank.batchCap` and `rank.windowCap` as unset config keys; `parallel runs` unset, so a wave is
sized by whoever dispatches it.

## Scope

**forge-dev only.** The master of forge-dev directs the rollout here first and does not set `train`
on another project, for the same reason the release chain is not set elsewhere.
