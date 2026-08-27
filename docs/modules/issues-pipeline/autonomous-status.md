# Autonomous mode — status transitions

How an issue moves on a project with `agentConfig.pipelineConfig.mode = 'autonomous'`. The staged
ladder is [status-pipeline.md](status-pipeline.md); the gate is [release-gate.md](release-gate.md).

## 1. Two vocabularies, one of them real

`issues.status` is the single kernel enum (16 values,
[`db/schema.ts`](../../../packages/core/src/db/schema.ts) `issueStatuses`). It does **not** change
per project — every gate, index and reaper reads it.

What changes is what a reader is *shown*.
[`contracts/src/issue-vocabulary.ts`](../../../packages/contracts/src/issue-vocabulary.ts) is a
**rendering map**, not a second state machine:

| Autonomous label | Kernel status written | Kernel statuses that render as it |
|---|---|---|
| `draft` | `draft` | `draft` |
| `open` | `open` | `open`, `reopen` |
| `running` | `in_progress` | `confirmed` `clarified` `approved` `in_progress` `developed` `testing` `released` |
| `needs_human` | `needs_info` | `waiting` `on_hold` `needs_info` |
| `awaiting_release` | `tested` | `tested` |
| `done` | `closed` | `closed` |
| `dropped` | `dropped` | `dropped` |

**Read this before the skill.** `forge-drive/SKILL.md` speaks in labels — "set `needs_human`",
"`done` stamps `merged_at`", "the issue is `running` from the moment you claim it". None of those
three strings is ever stored. Looking for them in the DB finds nothing.

## 2. Dispatch is one status wide

`autonomousStepFor` answers for `open` and for nothing else. `dispatchAutonomous` then returns
`true` for **every** status of an autonomous project, including the ones it enqueues nothing for.

> // cm:guard `true` on every status of an autonomous project, not just the entry one: falling
> through to the staged resolver at any other status would pause the run with a missing-skill
> comment the moment the agent moved its own issue

That is the whole reason the agent can move the issue anywhere without spawning a second job. One
`drive` job per issue is enforced by a unique index on `(issueId, type)`; a race that loses is
correct, not an error.

The operator gate is `states.open`: `enabled: false` or `mode: 'manual'` stops the driver from
starting. Only those two knobs — the per-step `autoTriage`/`autoCode` toggles name stages this mode
does not have. Pressing **Run** (`dispatchDriveManual`) bypasses the gate on purpose, because "Run"
*is* the human the gate was waiting for.

## 3. Two kernel rewrites

Both live in `transitionIssueStatus` and both land **after** the guards have run against the
*requested* status. Order is load-bearing:

> // cm:guard everything ABOVE this line reads `requestedStatus` (what the caller asked for) and
> everything BELOW writes `toStatus` (what the kernel will store); mixing the two either drops the
> reopen reason and counter or drops the rewrite, and each failure is silent

### `reopen` → `open` — [`issues/autonomous-reopen.ts`](../../../packages/core/src/issues/autonomous-reopen.ts)

An autonomous project has no steps, so an issue landing on `reopen` is queued for a driver that will
never look at it. It rendered as a live session and the reconciler counted a rescue every 60s —
epodsystem ISS-141 sat there over an hour on 2026-08-24.

What `reopen` *means* survives the rewrite, because the guards ran first: `reopenCount` still
increments and the authored reason is still required and still posted under its `🔁 Reopened from X`
heading. Measured: 12 such comments on autonomous projects.

Staged projects and every other target pass through untouched.

### `closed` → gate status — [`issues/release-gate-hold.ts`](../../../packages/core/src/issues/release-gate-hold.ts)

An agent may finish an issue; it may not declare it shipped. On a project that declares a gate, a
**device** actor's `closed` is rewritten to the gate status and a hold comment is posted;
`merged_at` is still stamped from the *requested* status, so `blocks` dependents are released on the
merge rather than waiting for the release.

Passes through untouched for: a human actor (closing by hand is a deliberate claim they own),
`release_batch finish` (`viaReleasePath`), staged projects, and `dropped`.

## 4. The gate is opt-in, and mostly off

`resolveReleaseGateStatus` returns `tested` for an autonomous project **only** when
`states.tested.mode === 'manual'`. Absent that, it returns `null` and the agent closes directly.

> // cm:guard on an AUTONOMOUS project the gate must be declared, never defaulted. […] an autonomous
> agent is BLOCKED from closing by this answer, so defaulting one on would park every issue of every
> project that never asked for a release path

Measured 2026-08-27:

| Project | `states.tested` | Gate |
|---|---|---|
| getcontent | `{enabled: false}` | off — agent closes directly |
| forge-dev | `{enabled: false}` | off |
| kinetrak | `{enabled: false}` | off |
| apiflow | `{mode: 'manual', enabled: true}` | declared |
| epodsystem-core | `{mode: 'manual', enabled: true}` | declared |

## 5. What actually happens

Observed transitions on issues that had a `drive` job, since 2026-08-15:

| From → To | n | issues |
|---|---|---|
| `draft` → `open` | 76 | 76 |
| `open` → `closed` | 44 | 44 |
| `open` → `dropped` | 43 | 43 |
| `open` → `waiting` | 8 | 8 |
| `on_hold` → `open` | 4 | 4 |
| `waiting` → `closed` | 3 | 3 |
| `open` → `on_hold` | 3 | 3 |
| `needs_info` → `open` | 2 | 2 |
| everything else | 1 each | — |

Two things to read off it. The happy path really is one hop: `open → closed`, no intermediate
status, exactly as the skill instructs. And **`dropped` is nearly half the outcomes** — that is the
agent applying the admission gates ("this is not work"), not a failure mode. On getcontent, 115
issues currently sit `dropped` against 53 `closed`.

## 6. What still binds the agent

Not advisory — these reject the write:

- **An authored reason** entering `reopen`, `waiting` or `needs_info`. Posted as a comment *before*
  the status flips; a failed post fails the whole transition. The `in_progress → reopen` pair is
  exempt because that is the system's own mechanical revert.
- **`waitingKind`** entering `waiting`: `needs_decision` or `needs_resource`. Required, never
  defaulted — an unstated kind must not be guessed.
- **Evidence checks** (`checkTransitionEvidence`) and the conditional UPDATE on the current status,
  which is what stops two concurrent transitions both winning.

## 7. What does NOT bind it

`canTransitionFree` permits **any** non-`draft` → **any** non-`draft`. The `transitions` map in
`state-machine.ts` carries its own warning:

> // cm:guard ADVISORY, NOT A GATE. Nothing enforces this map.

So the skill's "there are no intermediate statuses" is a **prompt-layer instruction, not a kernel
gate**. An agent that writes `developed` succeeds. The fleet already shows drift: one
`open → in_progress`, one `approved → on_hold`, one `reopen → tested`. Treat the one-hop path as
what the agent is *told*, never as what the kernel *guarantees*.

## THE STANDARD — the autonomous transition contract

Everything above describes what the code does today. This section is the **rule**: what the
autonomous driver may write, what happens when it writes something else, and which half of each rule
a machine actually enforces.

One sentence it all rests on:

> **The driver owns the issue from claim to finish, so its status vocabulary is five values wide.
> Anything outside those five is either rewritten by the kernel or is a state no dispatcher will
> serve.**

### S1 — The closed set

The driver may write exactly these five:

| Status | Renders as | Means | Terminal |
|---|---|---|---|
| `open` | `open` | claimed, the drive job owns it | no |
| `in_progress` | `running` | a session is working it | no |
| `needs_info` | `needs_human` | **the driver is asking a human a question** | no |
| `closed` | `done` | finished; stamps `merged_at` | yes |
| `dropped` | `dropped` | not work; does NOT stamp `merged_at` | yes |

`tested` is a sixth status the driver may *end up at* and may never *write*: it arrives only through
the gate rewrite in S3. Everything else — `confirmed` `clarified` `approved` `developed` `testing`
`released` `waiting` `on_hold` `reopen` `draft` — is **not the driver's to write**.

### S2 — One park, and why it is that one

> **The driver's only park is `needs_info`.**

Not a style preference. `answer-resume.ts` restarts a session when a human comments, and it does so
for `needs_info` and nothing else — deliberately, because `waiting` and `on_hold` mean *a person
stopped this* and a comment on one is discussion, not permission to restart.

So a driver that parks anywhere else has parked somewhere that **never wakes up**. The issue then
waits for a human to move it by hand, which is the opposite of what asking a question was for.

Measured 2026-08-27 on issues that had a `drive` job: the driver wrote `waiting` **27 times across 18
issues** (each with its `⏸ Waiting on…` reason comment, so these are deliberate driver parks, not
core bookkeeping) against `needs_info` **twice**. Twenty-five of twenty-seven parked issues cannot
resume on an answer. Eight issues currently sit parked for an average of 758 hours.

`on_hold` is a separate case and is **not** the driver's to fix or to write: `cancelPipelineRun`
parks a cancelled run's issue there with a synthesised device actor and `skip: true`, which is why
those eight rows carry no reason comment. Core owns that edge.

### S3 — What the kernel does to a write it will not take

Two rewrites, both applied after the guards have run against the *requested* status, so the
requested status's meaning survives:

| Driver writes | Kernel stores | When | Why |
|---|---|---|---|
| `reopen` | `open` | always, on an autonomous project | no step serves `reopen`; the issue would queue for a driver that never looks at it. `reopenCount` still increments and the reason is still required. |
| `closed` | the gate status (`tested`) | device actor · project declares `states.tested.mode: 'manual'` | an agent may finish an issue, not declare it shipped. `merged_at` is still stamped, so `blocks` dependents release on the merge. |

A human's close, `release_batch finish`, a staged project and `dropped` all pass through untouched.

### S4 — Enforced, versus merely instructed

The distinction this repo keeps learning the hard way: a rule that is documented and non-blocking
drifts. Per rule, today:

| Rule | Level | What happens on violation |
|---|---|---|
| An authored reason entering `reopen` / `waiting` / `needs_info` | **kernel** | comment posted *before* the status write; a failed post rejects the whole transition |
| `waitingKind` entering `waiting` | **kernel** | write rejected; never defaulted |
| Conditional UPDATE on the current status | **kernel** | the losing side of a concurrent transition gets `STALE_TRANSITION` |
| The two rewrites (S3) | **kernel** | silently applied, by design |
| **The five-status closed set (S1)** | *prompt only* | <span aria-hidden="true">⚠</span> nothing happens — the write succeeds |
| **`needs_info` as the only park (S2)** | *prompt only* | <span aria-hidden="true">⚠</span> nothing happens — and the issue never wakes |

`canTransitionFree` permits any non-`draft` → any non-`draft`, and the `transitions` map in
`state-machine.ts` carries its own `cm:guard` reading *"ADVISORY, NOT A GATE. Nothing enforces this
map."* So S1 and S2 are, as of today, instructions to an agent and nothing more — and the fleet has
already drifted against both: 27 `waiting` parks, one `open → in_progress`, one `approved →
on_hold`, one `reopen → tested`.

### S5 — How this becomes a gate

The mechanism this repo already uses for exactly this class of rule: a conformance checker, not a
kernel rewrite.

A rewrite is wrong here. The two in S3 each fix a state that is *unrepresentable* — `reopen` on a
project with no step to serve it, a shipped-claim from an actor with no authority to make it.
A driver's `waiting` is neither: it is a legal status with a real meaning, written by the wrong
author. Rewriting it would also catch core's own cancel-park and make a wedged job look like the
agent asked a question, so `answer-resume` would restart a session over a question nobody asked.

**What the gate can and cannot see.** Every checker in `scripts/` is static — it reads repo files,
and CI has no database. So the rule splits in two, and only one half is gated today:

| Half | Where it lives | Gated |
|---|---|---|
| **The specification** — what the surfaces TELL the agent to write | `AUTONOMOUS_DRIVER_STATUSES`, S1's table, the five bundled `SKILL.md` files | **yes**, `check-autonomous-transitions.mjs` |
| **The behaviour** — what an agent actually wrote | `activity_log` | no — needs a runtime surface, see below |

`scripts/check-autonomous-transitions.mjs` runs in the `codemap` job (same axis, node-builtins only,
so it rides a job already in `ci-passed`'s `needs` **and** its result loop) and in `pnpm verify`.
Three rules:

- **R1** — the `## Statuses you may write` table in `forge-drive/SKILL.md` lists exactly the five in
  `AUTONOMOUS_DRIVER_STATUSES`.
- **R2** — S1's table above lists exactly those five.
- **R3** — no bundled skill instructs a **render label**. `needs_human`, `done` and `running` are
  names from `packages/contracts/src/issue-vocabulary.ts`, read by `web-v2` to draw a board.
  Nothing on the write path translates them and `forge_issues` takes `issueStatuses` only, so a
  skill that names one hands the agent a value the API rejects and leaves it to guess.

R3 is the rule with teeth, because that guess is where the 27 came from. Measured 2026-08-27,
before the fix: `forge-drive` said *"Set `needs_human`"*, `forge-understand` said
*"that is `needs_human`, not a guess"* and *"`dropped`, never `done`"*, `forge-ship` said
*"`done` when your work is on the base branch"* and *"never leave it `running`"*. Six instructions
across three skills, none of them writable. The agent picked `waiting` 27 times — a park
`answer-resume.ts` never wakes.

**What is still ungated.** A skill can be correct and an agent can still write `waiting`; nothing
static sees that. The runtime half belongs at the MCP boundary — `forge_issues` rejecting an
un-`skip`ped device-actor write outside S1 on an autonomous project, naming the correct status the
way `TRANSITION_REASON_REQUIRED` already does. That is not the rewrite rejected above: it never
touches `cancelPipelineRun`'s `skip: true` park, and it is unit-testable. It is not built, and the
18 issues currently parked at `waiting` are the reason to freeze before blocking rather than after.

## 8. Known gap — a park that never wakes up

`answer-resume.ts` restarts a session when a human comments, and it does so for **`needs_info`
only**:

> // cm:guard `needs_info` ONLY, never the other two parks the autonomous vocabulary also renders as
> needs_human — `waiting` and `on_hold` are stopped by a person, and a comment on one is discussion,
> not permission to restart

The skill told the agent to "set `needs_human`" — and nothing on the write path maps that to
`needs_info`. `LABEL_TO_KERNEL` is read by `web-v2` to draw a board; `forge_issues` accepts
`issueStatuses` and nothing else, so the instruction named a value the API rejects and the agent
chose for itself. Fixed 2026-08-27 across all five bundled skills and gated by R3 above. Device-actor parks on issues that had a `drive` job:

| Park written | transitions | issues | Auto-resumes on a comment? |
|---|---|---|---|
| `waiting` | 27 | 18 | **no** |
| `on_hold` | 8 | 7 | **no** |
| `needs_info` | 2 | 2 | yes |

**25 of 27 parked drive issues do not restart when a human answers.** They wait for someone to move
them by hand. Currently parked on autonomous projects: 8 at `on_hold` (average 758 hours), 3 at
`needs_info` (353h), 6 at `waiting` (53h).

Both halves of the fix are legitimate and they are different decisions — make the skill write
`needs_info` when it means "I asked a question", or widen `answer-resume` to cover an agent-entered
`waiting`. The guard above argues against the second for a human-entered park, so distinguishing
*who* entered the park is likely the real shape.

## 9. Open verification item

apiflow declares the gate (`tested.mode: 'manual'`) yet shows **7 `open → closed` transitions by a
device actor, 0 issues via `tested`, and 0 hold comments**. epodsystem-core, configured identically,
demonstrably held once (`reopen → tested`, then `tested → closed`) on 08-23.

Either `states.tested.mode` was added to apiflow after those closes, or the gate did not fire. The
`projects` table has no `updated_at`, so config history is not reconstructible from the DB — this
needs checking against whoever changed the config. If the gate did not fire, an autonomous agent
self-declared seven issues shipped.
