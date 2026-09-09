# One status vocabulary, and a transition table that refuses

The lane changed and the status enum did not. Sixteen kernel statuses remain; the driver writes
five; the config offers four; the board renders eight labels. Nothing refuses a hop between any of
them. This file prices the cleanup and names the order.

Measured 2026-09-09 against forge-beta's own database and this tree.

## What is actually true today

Four independent lists claim to describe one lifecycle, and no two agree:

| List | Where | Members |
|---|---|---|
| kernel enum | `core/src/db/schema.ts#issueStatuses` | **16** |
| what the driver writes | `core/src/pipeline/autonomous-mode.ts#AUTONOMOUS_DRIVER_STATUSES` | **5** — `open` `in_progress` `needs_info` `closed` `dropped` |
| what a project may configure | `core/src/pipeline/pipeline-config-schema.ts#STAGE_NAMES` | **4** — `open` `in_progress` `needs_info` `released` |
| what a reader is shown | `contracts/src/issue-vocabulary.ts#AUTONOMOUS_LABELS` | **8** |

`STAGE_NAMES` is the closest thing to a decided answer and it already exists. The enum is what never
caught up.

**Decision, 2026-09-09 (owner).** The target set is the nine below: `released` is retired as a
status and replaced by the release *button* plus a new in-flight status `releasing`; `reopen` stays.
Rationale and the mechanism it fixes are in "The vocabulary" section.

### The transition table is advisory, and says so

`core/src/pipeline/state-machine.ts` holds a `transitions` map covering all sixteen statuses. Its
own first guard reads:

> **ADVISORY, NOT A GATE. Nothing enforces this map.** `canTransitionFree` below is the only runtime
> check and it permits ANY non-draft from → ANY non-draft to.

So the runtime rule is two lines: `draft` is never a target, and a `draft` may only reach five
places. Everything else is legal. `approved → in_progress`, `tested → open`, `released → waiting` —
all permitted, none meaningful. The map is read by system-prompt generation and the UI's
next-state suggestions, which is how a retired ladder keeps teaching itself to agents and operators.

### Four enum members hold zero rows anywhere

`confirmed`, `clarified`, `testing`, `reopen` — 0 live rows across 28 projects. They are dead
vocabulary that still appears in prompts, UI pickers and 33 non-test source files.

### And 433 rows are stranded on statuses the kernel does not drive

| Status | Rows | Projects | Still written since Sep 1? |
|---|---|---|---|
| `draft` | 275 | 20 | yes — the ingress state, legitimately alive |
| `released` | 79 | 13 | yes — **load-bearing**, `RELEASE_GATE_STATUS` |
| `on_hold` | 35 | 10 | yes — renders as `paused`, a pause a person chose |
| `waiting` | 30 | 9 | yes — but the driver's `waiting` is rewritten to `needs_info` |
| `approved` | 10 | 5 | yes, last write 2026-09-09 |
| `tested` | 3 | 3 | yes |
| `developed` | 1 | 1 | yes, last write 2026-09-09 |

The last three are the retired ladder still receiving writes. `approved` is the sharpest case: on
sidpeak five issues sit there, and that project's config has **no `approved` entry at all** — pool
does not offer it, no stage accepts it, so those five have no machine exit. Three are `critical`,
merged onto staging, parked with a `forge-record kind:` a person owes an answer to; two are
unmerged work whose run died, each blocking an `open` issue.

That is the cost of the gap, and it is not hypothetical: it is five issues on one project, found by
being asked how many issues were unfinished.

## What to build

### The vocabulary: the owner's set

Decided 2026-09-09 by the owner: **`released` goes, `reopen` stays**, the release *status* is
replaced by a release **button**, and the batch gets a status of its own — an issue enters it when
the release trigger fires and only reaches `closed` when the release finishes.

| Kind | Status | Rule it enforces |
|---|---|---|
| ingress | `draft` | filed, not admitted; only five exits |
| rung | `open` | the ONE status that dispatches (`autonomousStepFor`) |
| rung | `in_progress` | a session holds it |
| rung | `releasing` | **NEW** — a release was triggered over this issue and is running |
| park | `needs_info` | a question a person owes an answer to; `answer-resume.ts` wakes it |
| park | `on_hold` | a pause a person chose (ISS-970 — NOT a question) |
| park | `reopen` | a person disagreed with a close; `isReopenEntry` counts the churn |
| end | `closed` | stamps `merged_at` |
| end | `dropped` | closes WITHOUT stamping |

**Nine.** `reopen` keeps its counter where it already lives, so nothing has to be moved onto a new
field.

**Retire eight.** Six are simply dead ladder — `confirmed` `clarified` `approved` `developed`
`testing` `tested`. `released` is a different kind of retirement and is the substance of this
section: its job moves to a button and a new status, not to nothing. And `waiting` is the eighth —
it is absent from the set above because the driver's `waiting` is already rewritten to `needs_info`
(`issues/autonomous-park.ts`, ISS-886), so the park it names is `needs_info`'s park.

**`waiting` costs more to retire than its 30 rows suggest**, and it is the one to plan rather than
discover. It is the only status carrying a second column — `waitingKind` (`needs_decision` /
`needs_resource`) — and that column has a refusal family around it:
`WAITING_KIND_REQUIRED` (a `waiting` that does not say which kind) and
`WAITING_KIND_NOT_APPLICABLE` (the kind sent to any other target). Both are named **by code** in
`guides/registry.ts` and `prompt/facts/registry.ts`, which is text an agent reads. So retiring
`waiting` retires the column, both refusals, `transition-reason.ts`'s requirement, and the two
pieces of teaching material that name the codes — in one change, or the guide teaches a code the
kernel no longer raises.

Whether `needs_info` should inherit the kind is the open question here. Today `needs_info` stores
no kind, so a question owed a *decision* and one owed a *resource* are the same row — and those are
different things to whoever has to unblock it (sidpeak ISS-368 is parked `needs_resource` on a tmux
name collision; ISS-389 `needs_decision` on a screen review). Folding `waiting` into `needs_info`
without carrying the kind loses that distinction on 30 live rows.

#### Why replacing `released` with a button is the right call, and what it fixes

`released` today is not a step an issue takes. It is a **waiting room** an issue is parked in so a
person can press something, and the code says so: `issues/release-gate-hold.ts` REWRITES an agent's
`closed` back to `released` on any project declaring a gate, because "an autonomous agent may finish
an issue, but it may not declare it shipped". The status exists to hold work still.

A button models that directly. `POST /:projectId/release-batches` already IS the button
(`release-batch/routes.ts`), with `finish` and `abort` beside it. What is missing is a status for
the middle.

**The gap this closes, measured.** During a batch, an issue keeps standing at `released` — the fact
that a release is in flight lives only in the `issues.release_batch_run_id` column, claimed by a CAS
`UPDATE`. So `released` means two different things at once: *waiting for someone to press it* and
*being released right now*. Nothing in the status can tell them apart. 16 `release_batch` jobs have
run — **4 failed and 2 cancelled** (pixelight and sidpeak, 2026-09-03 → 09-08), and each of those
is precisely the case where the two meanings diverge and no reader can see which one they are
looking at.

`releasing` makes the in-flight state representable, and the column becomes what it should be — the
identity of *which* batch, not the existence of one.

#### What each half becomes

| Concern | Today | After |
|---|---|---|
| "ready to ship, waiting on a person" | status `released` | **no status** — the issue stays at its last rung; readiness is derived (merged mark + gate declared), and the button is enabled or it is not |
| "shipping right now" | invisible; a non-null column on a row still reading `released` | status **`releasing`** |
| "shipped" | `closed`, written by `finish` | unchanged — `closed`, written by `finish` |
| "release failed / aborted" | issue silently back at `released`, column cleared | **`releasing` → `reopen`**, carrying the abort reason |

That last row is the second thing this fixes. `abortReleaseBatch` clears `release_batch_run_id` and
leaves the issue exactly where it was, so a failed release is indistinguishable from one never
attempted. Landing it on `reopen` — the status that already means *a close did not hold* — puts it
in front of a person with its reason attached, and `isReopenEntry` counts it.

#### The one thing to get right, or this is worse than today

`release-gate-hold.ts` must not simply be deleted. It is what stops an agent declaring its own work
shipped, and that guard was written from an incident: epodsystem ISS-141 self-closed with the
reported bug still reproducing and a human reopened it five minutes later.

With `released` gone, the rewrite target goes with it — so the refusal has to move, not vanish. An
agent's `closed` on a gated project must be **refused by name** ("this project releases through a
batch; your work is landed and the release is a person's to trigger") rather than rewritten to
somewhere quieter. That is the loud-break rule, and it is a behaviour change for every autonomous
project with a gate: today the agent's close succeeds and lands at `released`, after this it fails
and the agent must stop instead.

### The transition table: make it refuse

Replace `canTransitionFree`'s permit-everything with the table as the gate. The precedent is in the
same file — `DRAFT_EXIT_TARGETS` is enforced, and the guard above it explains why. Extend that shape
to every row.

This is the load-bearing half of the change. Without it the enum shrinks and the next logic switch
strands rows again, for the same reason this one did.

### What this proposal does not cover: the run axis

This is the ISSUE axis only. A separate ruling (2026-09-09, owner) governs run lifetime — *a run
must not outlive its parent; the parent waits for the child* — which is the ledger's
`incarnation` × `work` × `blocker_kind`, not `issues.status`. The two meet at exactly one place:
**the park set**.

They are compatible as written, and the reason is structural rather than lucky. A question is a
durable row that outlives the run that asked it (`agent_questions.agent_session_id` is nullable,
the waiter is a separate row that cascades from the question, and `answerOf` is non-consuming and
idempotent), so "the child ends leaving a resumable checkpoint" and "`needs_info` means a person
owes an answer" are the same park seen from two axes. `needs_info` keeps its meaning with the run
already gone.

**The run ruling removes a cause of the stranding measured above, rather than changing what a
status means.** Two of the five sidpeak `approved` rows are unmerged work whose run died — that is
the orphan class, and the ruling deletes it structurally instead of sweeping for it. So this
vocabulary work does not wait on the run axis, and the run axis does not wait on this.

One measurement from the box's ledger belongs here because it bounds what either axis may claim:
**`questions = 0` — nothing has ever parked in production.** There is no migration debt on park
semantics, and equally the resume edge has never executed. The first real park is also the first
test of it, so neither axis may call park/resume shipped until a park is planted and the resume is
watched happening.

## Order, and why this order

1. **Add `releasing`** to the enum and make the batch write it: `createReleaseBatch` transitions
   each claimed issue `→ releasing` in the same transaction as the CAS claim, `finish` goes
   `releasing → closed`, `abort` goes `releasing → reopen` with the reason. This ships FIRST and on
   its own: it is additive, breaks no caller, and until it exists there is nowhere for a released
   issue to stand.
2. **Move the gate refusal.** `release-gate-hold.ts` stops rewriting `closed → released` and starts
   refusing an agent's close by name on a gated project. This is the behaviour change with teeth —
   see the costs table.
3. **Drain `released`.** 79 rows across 13 projects, and they are NOT uniform: each is either
   genuinely awaiting a trigger (→ back to its last rung, readiness derived) or was mid-batch when
   something died (→ `releasing`, or `reopen` if its batch is already terminal). Read the batch run,
   not a blanket rule.
3b. **Retire `released` as a target**, then drop it from the enum. `RELEASE_GATE_STATUS` becomes
   `releasing`, and `STAGE_NAMES`' `released` entry goes — which means touching the 21 project
   configs that still enable it.
4. **Freeze the other six** (`confirmed` `clarified` `approved` `developed` `testing` `tested`) as
   transition targets, loudly, then drain their 14 rows one record at a time, then drop them from
   the enum with the CHECK.
4b. **`waiting` last, and as its own step.** Decide the kind question first (does `needs_info`
   inherit `waitingKind`?), because the answer decides whether the drain is a status rewrite or a
   status rewrite plus a column migration. Then retire the status, the column, both
   `WAITING_KIND_*` refusals, and the guide/fact text naming them by code — together. Its 30 rows
   are readable through MCP only since `30e1ed0ad` (which added `waitingKind` to both MCP
   projections); before that every MCP read of a park came back with no kind, so any drain written
   against pre-`30e1ed0ad` reads was working blind.
5. **Enforce the table.** `canTransitionFree` reads `transitions`; the advisory guard comes off; the
   refusal names the legal exits from the source status. Nine statuses make this small enough to
   read in one screen, which is the point.
6. **Sweep the teaching material** — system-prompt generation, UI pickers, `docs/modules/
   lifecycle-pipeline/README.md`, and the cross-repo half in `forge-plugin`'s
   `plugin/skills/issue-flow/SKILL.md`, which the `cm:guard` on `AUTONOMOUS_DRIVER_STATUSES` names
   as the coupling no gate can hold.

Step 1 before step 2 and step 2 before step 3 is the whole ordering. Refuse the close before
`releasing` exists and a gated project's agents have nowhere legal to end. Drain `released` before
the rewrite stops and the rewrite refills it — the same trap as the six, for the same reason.

## Honest costs

| Cost | Borne by |
|---|---|
| The refusal in step 1 breaks any caller still naming a retired status — including agents mid-run and any project skill with a stale status table. That is the intended failure mode, but it fails at the caller, not at deploy | every agent and operator, on their first attempt after the deploy |
| Step 2 cannot be blanket-mapped. Each of the 14 rows carries a `forge-record` or a dead lease, and re-parking one wrongly is what set sidpeak ISS-389 to `open` and nearly re-drove finished work | whoever writes the migration, one row at a time |
| `reopen` retirement moves `isReopenEntry`'s churn counter onto a new field. Until it lands, reopen-rate metrics before and after are not comparable | anyone reading reopen metrics across the boundary |
| The enum shrink is a migration on the largest table plus a CHECK. `SELECT *` consumers see no change, but any consumer with its own hardcoded union fails to parse a row it now cannot represent — the safe direction only if every one of them is found first | the migration, and every client union of the status enum |
| `waiting`'s retirement is four couplings in one change: the status, the `waitingKind` column, two typed refusals, and the guide + fact text that name those refusal codes to agents. Miss the text and the guide teaches a code the kernel no longer raises | whoever ships step 4b, and every agent reading the stale guide until it lands |
| The cross-repo half ships on `forge-plugin`'s clock. Between the two deploys, the skill's status table and the kernel's disagree — the exact shape that produced 4,806 wrong calls when the drive prompt and the guide diverged (`run_session.rs` `cm:guard`) | both repos, for the length of the gap |
| The gate refusal in step 2 is a real behaviour change: today a gated project's agent closes and lands at `released`; after this its close FAILS and it must stop instead. Every autonomous project with a gate feels it on the first run, and the plugin's skill has to teach the new ending | every gated project's driver, from the deploy |
| 21 projects have `released` enabled in config and 13 hold rows there, so step 3b edits 21 project configs — and `pipelineConfig.states` is a WHOLESALE replace (burned live 2026-06-22): a patch that omits a sibling key wipes it | whoever runs the config migration, GET-then-send per project |
| `releasing` is a status a batch can die inside. A crashed release leaves rows there exactly as a dead run leaves a lease — so it needs a reaper of its own, or it becomes the next `approved`: a status with no machine exit. Nothing in this proposal builds one yet | whoever ships step 1, or the person who finds the stuck row |
| Readiness stops being a status and becomes derived (merged mark + gate declared). Anything that today answers "what is ready to ship" by selecting `status = 'released'` — queries, the UI list, `readiness.ts` — has to compute it instead | every reader of the release queue |
| Doing nothing has a price too, and it is the measured one: 433 rows on undriven statuses, five of them with no machine exit, found only because someone asked a counting question | the next person who asks |
