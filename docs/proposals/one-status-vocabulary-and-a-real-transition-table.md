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

### The vocabulary: four rungs, three parks, two ends

Nothing here is invented — each is a status already carrying rows and rules.

| Kind | Status | Rule it already enforces |
|---|---|---|
| ingress | `draft` | filed, not admitted; only five exits |
| rung | `open` | the ONE status that dispatches (`autonomousStepFor`) |
| rung | `in_progress` | a session holds it |
| rung | `released` | merged to base, running there, awaiting promotion — `RELEASE_GATE_STATUS`, derived from the project |
| park | `needs_info` | a question a person owes an answer to; `answer-resume.ts` wakes it |
| park | `on_hold` | a pause a person chose (ISS-970 — NOT a question) |
| end | `closed` | stamps `merged_at` |
| end | `dropped` | closes WITHOUT stamping |

**Eight.** The kernel set and the render set become the same list, and
`issue-vocabulary.ts`'s 16→8 fold stops being a translation layer.

**Retire seven:** `confirmed` `clarified` `approved` `developed` `testing` `tested` `reopen`.

`reopen` deserves its own line: it holds 0 rows, but `isReopenEntry` counts churn through it and the
`released`→board mapping depends on the autonomous rewrite landing it at `open`. Retiring it means
moving that counter onto an explicit field, not deleting the measurement.

### The transition table: make it refuse

Replace `canTransitionFree`'s permit-everything with the table as the gate. The precedent is in the
same file — `DRAFT_EXIT_TARGETS` is enforced, and the guard above it explains why. Extend that shape
to every row.

This is the load-bearing half of the change. Without it the enum shrinks and the next logic switch
strands rows again, for the same reason this one did.

## Order, and why this order

1. **Freeze the writes.** Refuse the seven retired statuses as transition *targets*
   (`NON_TARGETABLE_STATUSES` already does this for `draft`, so the mechanism exists). Rows keep
   holding them; nothing new arrives. **A loud refusal here is the point** — a caller naming
   `approved` should be told the status is retired and what replaced it, never silently redirected.
2. **Drain the 14 rows** (`approved` 10, `tested` 3, `developed` 1) with a one-shot migration that
   re-parks each by what its record says, not by a blanket rule. The schema's own `cm:why` records
   the precedent: `pass`, `staging` and `deploying` were removed exactly this way, and their absence
   from the enum today is the proof it works.
3. **Enforce the table.** `canTransitionFree` reads `transitions`; the advisory guard comes off; the
   refusal names the legal exits from the source status.
4. **Shrink the enum**, with the CHECK constraint, after 1–3 leave it unreachable.
5. **Sweep the teaching material** — system-prompt generation, UI pickers, `docs/modules/
   lifecycle-pipeline/README.md`, and the cross-repo half in `forge-plugin`'s
   `plugin/skills/issue-flow/SKILL.md`, which the `cm:guard` on `AUTONOMOUS_DRIVER_STATUSES` names
   as the coupling no gate can hold.

Step 1 before step 2 is the whole ordering: drain first and the writers refill it.

## Honest costs

| Cost | Borne by |
|---|---|
| The refusal in step 1 breaks any caller still naming a retired status — including agents mid-run and any project skill with a stale status table. That is the intended failure mode, but it fails at the caller, not at deploy | every agent and operator, on their first attempt after the deploy |
| Step 2 cannot be blanket-mapped. Each of the 14 rows carries a `forge-record` or a dead lease, and re-parking one wrongly is what set sidpeak ISS-389 to `open` and nearly re-drove finished work | whoever writes the migration, one row at a time |
| `reopen` retirement moves `isReopenEntry`'s churn counter onto a new field. Until it lands, reopen-rate metrics before and after are not comparable | anyone reading reopen metrics across the boundary |
| The enum shrink is a migration on the largest table plus a CHECK. `SELECT *` consumers see no change, but any consumer with its own hardcoded union fails to parse a row it now cannot represent — the safe direction only if every one of them is found first | the migration, and every client union of the status enum |
| The cross-repo half ships on `forge-plugin`'s clock. Between the two deploys, the skill's status table and the kernel's disagree — the exact shape that produced 4,806 wrong calls when the drive prompt and the guide diverged (`run_session.rs` `cm:guard`) | both repos, for the length of the gap |
| 21 projects have `released` enabled in config, and 13 hold rows there. `released` STAYS — but this means the cleanup cannot be described to operators as "the ladder is gone" | whoever writes the operator-facing note |
| Doing nothing has a price too, and it is the measured one: 433 rows on undriven statuses, five of them with no machine exit, found only because someone asked a counting question | the next person who asks |
