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

**Decision, 2026-09-09 (owner), amended 2026-09-10.** The target set is **ten**: the nine below
plus `awaiting_release`. `reopen` stays.

The amendment is the substance of the whole release half. On 2026-09-09 the ruling was read as
*`released` is retired*, and steps 2, 3 and 3b below were written for that. The owner corrected it
on 2026-09-10: **`released` was doing two jobs, and only one of them is being removed.** It was the
gate where merged work waits for production — that rung is real and stays — AND it was the trigger
that started a release, because the old lane had no button. Splitting them gives each an honest
name:

| Job | Old | New |
|---|---|---|
| where merged work waits | status `released` | status **`awaiting_release`** (migration 0228 — a rename, not a new rung) |
| starting a release | moving an issue to `released` | the **RELEASE button** (`POST /:projectId/release-batches`) |
| a release in flight | invisible; a column on a row still reading `released` | status **`releasing`** (migration 0227) |

`released` was the past tense of an action that had not happened, and every reader had to know that
"released" meant "not released". `AUTONOMOUS_LABELS` has rendered this rung as `awaiting_release`
since ISS-970 — only the kernel status disagreed, and now it does not.

**What the amendment cancels: steps 2, 3 and 3b.** There is nothing to drain, no readiness to
derive, and no gate refusal to move. `release-gate-hold.ts` keeps rewriting an agent's `closed` to
the gate, which is how work reaches the gate at all — and, measured on the way to the amendment,
that rewrite is also what stamps `merged_at` (`markMergedOnClose` keys on `requestedStatus`, not on
the stored status), closes the run and fans out to dependents. Refusing the close would have taken
all three away and left the issue at `in_progress` unmerged, invisible to any release roster.

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
| `released` → `awaiting_release` | 80 | 13 | yes — **load-bearing**, `RELEASE_GATE_STATUS`. Renamed in 0228, not drained |
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

Decided 2026-09-09 by the owner and amended 2026-09-10: **the release *trigger* goes, `reopen`
stays**, the trigger is replaced by a release **button**, the batch gets a status of its own
(`releasing` — entered when the trigger fires, reaching `closed` only when the release finishes),
and the waiting rung keeps existing under an honest name (`awaiting_release`). See the amendment at
the top: the first reading of this ruling retired the rung along with the trigger, which is one job
too many.

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

**Retire seven, rename one.** Six are simply dead ladder — `confirmed` `clarified` `approved`
`developed` `testing` `tested`. `released` is not retired at all: it is RENAMED to
`awaiting_release`, and only its second job — being the trigger — moves to a button and to
`releasing`. And `waiting` is the seventh retirement —
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

Whether `needs_info` should inherit the kind is the open question here, and the count decides how
much it is worth. Read from `waiting_kind` in Postgres (not through MCP, which returned no kind for
every row before `30e1ed0ad`): **24 `needs_decision`, 6 `needs_resource`, none null.**

The 24 lose nothing by folding — a question owed a decision *is* what `needs_info` means. The six
are the whole question, and five of them are real external dependencies, read one row at a time:

| Row | Waiting on |
|---|---|
| sidboss ISS-95 | an upstream npm publish (`@sidcorp/react-kit` still 0.1.0, checked not assumed) |
| sid-desk ISS-64 | a person; QA done, 19/19 walked |
| sid-desk ISS-69 | a person; 16 of 18 live checks passed |
| sid-desk ISS-123 | production `chat_messages` row count, unmeasured — needs prod access |
| sid-desk ISS-132 | a GitLab push credential the runner does not have (`pre-receive` rejects) |
| sidpeak ISS-368 | a tmux run-pane name collision — **the one mechanism artifact** |

So the honest figure is **5 of 30 carry a resource distinction that survives the run-axis change**.
ISS-132 is the sharpest case for keeping it: no amount of deciding produces a push credential, and
folding it into `needs_info` files it next to "somebody should look at this screen".

One of the six is also a warning about blanket drains. ISS-368's park comment names its cause as
"pixelight's run is live right now" — true when written, and the spawn refusal shipped in
`runner-v0.12.4` since, so the *stated* cause no longer holds even though the tmux namespace
collision does. That row needs re-parking or closing on its own evidence, not a status rewrite.

#### Why the trigger becomes a button, and what that fixes

`released` was never a step an issue takes. It is a **waiting room** an issue is parked in so a
person can press something, and the code says so: `issues/release-gate-hold.ts` REWRITES an agent's
`closed` back to the gate on any project declaring a gate, because "an autonomous agent may finish
an issue, but it may not declare it shipped". The status exists to hold work still — which is
exactly why the rung survives and only its name changes. What could not survive is the same status
*also* being the trigger: a rung an issue rests on and an action a person takes are not the same
kind of thing, and one identifier cannot be both.

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
| "ready to ship, waiting on a person" | status `released` — a name in the past tense for a thing that had not happened | status **`awaiting_release`** — the same rung, told the truth (migration 0228) |
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

**Superseded by the 2026-09-10 amendment.** This section argued that with `released` gone the
rewrite target goes with it, so the refusal had to move: an agent's `closed` on a gated project
refused by name rather than rewritten. The rung is not gone, so the rewrite keeps its target and
nothing moves.

Worth keeping is what the investigation turned up, because it would have made the refusal a
regression rather than a loud break: `markMergedOnClose` keys on **`requestedStatus`**, not on the
stored status, so a held close already stamps `merged_at`, and `apply-transition.ts` then closes the
run and reports `terminal: true` on the strength of that stamp. The hold gives an agent's close its
full effect except the status. A bare refusal would have removed all three at once and left the
issue at `in_progress` with no merge stamp — dependents still blocked, the run still open, and
nothing on any release roster.

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
   Two sites must move in the SAME change or the new status is worse than the old union:
   `issues/apply-transition.ts#TERMINAL_FOR_DISPATCH` must include `releasing` (or an issue
   mid-release is dispatchable), and `ws/master-wake.ts#MASTER_WAKE_STATUSES` must wake a master on
   the derived *readiness* condition and NOT on `releasing` (or every in-flight batch wakes a
   master with nothing to claim). The three orphan sweeps need nothing: `runs-cascade.ts`,
   `loop-monitor.ts` and `runs-concluded.ts` hold zero references to `released` — they key on
   run/job terminality, verified 2026-09-09.
2. ~~**Move the gate refusal.**~~ **CANCELLED by the 2026-09-10 amendment.** `released` is not
   retired, so there is no rewrite to remove. Shipped instead: `awaiting_release` (migration 0228)
   — the enum member, `RELEASE_GATE_STATUS`, `BASE_MERGE_STATE`, `STAGE_NAMES`, the 80 issue rows,
   the `states.released` key on 29 project configs and the `poolBacklog.statuses` element on 1, all
   in one transaction. The config keys are the load-bearing half: `states` is a
   `partialRecord(z.enum(STAGE_NAMES))`, zod 4 answers `invalid_key` rather than stripping, and
   `orchestrator.ts` reads a failed parse as `cfg = null` — `isAutonomous` false, no dispatch, in
   silence, on 29 projects.
   Four SQL readers of `activity_log.payload->>'to'` now accept BOTH spellings and say why: 4,488
   rows were written while the rung was called `released` and no migration rewrites history.
3. ~~**Drain `released`.**~~ **CANCELLED — nothing to drain.** The 80 rows are the gate's legitimate
   queue and they keep standing on it under the new name. Measured 2026-09-10, 0 of the 80 were
   claimed by a batch, so none was mid-release; 73 carry `merged_at` and 7 do not (those 7 predate
   the gate).
3b. ~~**Retire `released` as a target.**~~ **CANCELLED.** Superseded by the rename.
   *What the measurement did surface, and it is not a status problem:* **79 of the 80 sit at a gate
   their project cannot open.** 38 rows on 6 projects have no active `prod` binding, so
   `resolveReleaseGate` returns `null` and the button is not even offered; 41 rows have a binding
   but no `releaseRunnerLabel`, which `createReleaseBatch` refuses by name; and 28 rows carry no
   `release_notes`, which `issuesMissingReleaseRecord` refuses. Only `pixelight` (1 row) can
   release today. Every one of those is a project declaration a person must make — none of it is
   fixed by code.
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
   refusal names the legal exits from the source status. Ten statuses make this small enough to
   read in one screen, which is the point.
6. **Sweep the teaching material** — system-prompt generation, UI pickers, `docs/modules/
   lifecycle-pipeline/README.md`, and the cross-repo half in `forge-plugin`'s
   `plugin/skills/issue-flow/SKILL.md`, which the `cm:guard` on `AUTONOMOUS_DRIVER_STATUSES` names
   as the coupling no gate can hold.

Step 1 before step 2 remains: the middle status has to exist before anything writes it. Steps 3
and 4 keep their own ordering rule — **freeze a status's writers, then drain its rows, then enforce**
— because a drain that runs while the writers are live is refilled behind you.

## Honest costs

| Cost | Borne by |
|---|---|
| The refusal in step 1 breaks any caller still naming a retired status — including agents mid-run and any project skill with a stale status table. That is the intended failure mode, but it fails at the caller, not at deploy | every agent and operator, on their first attempt after the deploy |
| Step 2 cannot be blanket-mapped. Each of the 14 rows carries a `forge-record` or a dead lease, and re-parking one wrongly is what set sidpeak ISS-389 to `open` and nearly re-drove finished work | whoever writes the migration, one row at a time |
| `reopen` retirement moves `isReopenEntry`'s churn counter onto a new field. Until it lands, reopen-rate metrics before and after are not comparable | anyone reading reopen metrics across the boundary |
| The enum shrink is a migration on the largest table plus a CHECK. `SELECT *` consumers see no change, but any consumer with its own hardcoded union fails to parse a row it now cannot represent — the safe direction only if every one of them is found first | the migration, and every client union of the status enum |
| `waiting`'s retirement is four couplings in one change: the status, the `waitingKind` column, two typed refusals, and the guide + fact text that name those refusal codes to agents. Miss the text and the guide teaches a code the kernel no longer raises | whoever ships step 4b, and every agent reading the stale guide until it lands |
| The cross-repo half ships on `forge-plugin`'s clock. Between the two deploys, the skill's status table and the kernel's disagree — the exact shape that produced 4,806 wrong calls when the drive prompt and the guide diverged (`run_session.rs` `cm:guard`) | both repos, for the length of the gap |
| ~~The gate refusal in step 2 is a real behaviour change~~ — **not incurred.** The amendment keeps the rewrite, so no driver's ending changes and the plugin's skill needs no second half for this. What the investigation found on the way: the rewrite is also what stamps `merged_at`, closes the run and fans out to dependents, so refusing the close would have cost all three | nobody, as it turned out |
| 29 project configs hold a `states.released` key. Paid in SQL, not through the API: a `jsonb_set` + `#-` key rename touches that one key and sidesteps the wholesale-replace hazard entirely (`pipelineConfig.states` patches REPLACE the map — burned live 2026-06-22). It had to be in the same transaction as the enum change, or 29 projects stop dispatching in silence | migration 0228, one statement |
| Folding `waiting` costs 5 rows their resource distinction, not 30 — but those 5 are the ones where the distinction is load-bearing (a missing credential, an unpublished package, unmeasured prod data). Whichever way the owner rules, 5 rows need re-parking by hand | whoever ships step 4b |
| `releasing` is a status a batch can die inside. A crashed release leaves rows there exactly as a dead run leaves a lease — so it needs a reaper of its own, or it becomes the next `approved`: a status with no machine exit. Nothing in this proposal builds one yet | whoever ships step 1, or the person who finds the stuck row |
| ~~Readiness stops being a status and becomes derived~~ — **not incurred.** Readiness stays a status; it just has an honest name. `loadReleaseRoster`, the preflight and the CAS claim keep keying on it | nobody |
| History keeps the old spelling forever: `comments.stage` (13 rows), `activity_log.payload` (4,488) and 7 `pipeline_runs.metadata.gateStatus` rows still say `released`, because a record says what a thing was called when it happened. Four SQL readers carry both spellings and a `cm:guard` saying why; drop either and a metric silently loses one side of 2026-09-10 | every reader of a cross-boundary metric |
| Doing nothing has a price too, and it is the measured one: 433 rows on undriven statuses, five of them with no machine exit, found only because someone asked a counting question | the next person who asks |
