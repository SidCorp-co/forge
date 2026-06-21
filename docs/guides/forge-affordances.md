# Operating affordances (use Forge's own tools)

Forge connects agents to a set of tools for the things agents otherwise do in
prose — recording a dependency, parking a note, writing config, recalling prior
work. The recurring failure mode is *skipping the affordance*: an agent writes
"this depends on ISS-42" in a comment instead of setting a `blocks` edge, so the
dispatcher never gates on it.

This guide teaches each affordance as **trigger → tool → semantics → red flag**,
not as a noun-list. If you only skim one thing, read the
[Red flags](#forge-red-flags) at the bottom.

> This is the canonical reference. The terse `## Operating affordances` table in
> the pipeline preamble (`pipeline-rules`) and the interactive chat orientation
> (`CHAT_NUDGE`) both point here; keep all three in sync — the table is authored
> once in `packages/core/src/prompt/facts/registry.ts`
> (`OPERATING_AFFORDANCES_TEXT`).

---

## Ordering between issues — `set_dependency kind:blocks`

**Trigger:** issue B must not start until issue A is done.

**Tool:** `forge_project_pm action=set_dependency` with `fromIssueId = <A, the
blocker>`, `toIssueId = <B>`, `kind: 'blocks'`.

**Semantics:** `blocks` is the **only** dispatch-affecting relation kind.
`(from=A, to=B, kind='blocks')` means B cannot dispatch until A reaches a
terminal status (`released`/`closed`). Edges are idempotent on
`(projectId, from, to, kind)`; `blocks` cycles are rejected with
`CYCLE_DETECTED`. The other kinds (`relates`, `duplicates`, `parent`,
`decomposes`) are metadata only — they do **not** gate dispatch. Do not invent
names like `blocked_by`/`depends_on`; they are not valid kinds.

**Red flag — `prose-deps`:** describing the dependency in a comment or plan
instead of setting the edge. Prose does not gate the dispatcher.

> The legacy dotted shim `forge_pm.set_dependency` is **deprecated** — its
> description redirects to `forge_project_pm (action=set_dependency)`. Prefer
> the action form.

---

## Record a note / follow-up — create at `draft`

**Trigger:** you want to capture a follow-up, an idea, or a "do this later" so it
isn't lost.

**Tool:** `forge_issues action=create` with `status: 'draft'`.

**Semantics:** `draft` is the inert holding state — it does **not** dispatch a
pipeline run. `open` is an active state: creating an issue at `open` (or moving
one there) triggers auto-triage, which spawns a real pipeline run for something
you only meant to jot down.

**Red flag — `open-as-note`:** filing a note at `open` and accidentally kicking
off triage/plan/code on a half-formed thought.

---

## Change project config — read before you write

**Trigger:** you need to change `pipelineConfig.states`, `projectFacts`,
`stateContext`, or another config map via `forge_config action=update`.

**Tool:** `forge_config action=get` first → modify the entry you intend to change
→ send back a **complete** entry, not a half-populated fragment.

**Semantics:** config writes are patch-merged per top-level key. Sending a
nested map you never read means any field you omit inside that entry is at risk
of being dropped relative to what you assumed was there. Always read-modify-write
so you don't clobber sibling fields you didn't intend to touch. (Secrets are
never stored here — they sync to disk.)

**Red flag — `wholesale-config-clobber`:** blind-patching a nested config map
without reading the current value first.

---

## Before you design / fix — recall memory first

**Trigger:** you're about to plan, reproduce, or fix something in an area you
haven't just touched.

**Tool:** `forge_memory.search({ projectId, query: <the feature/file/error>,
topK: 3, sourceFilter: ['knowledge', 'policy'] })`.

**Semantics:** project memory is **not** auto-loaded into your prompt. It holds
conventions, gotchas, decisions, and fix-patterns prior work established. Recall
hits are point-in-time — verify against live code/git before relying on them.
This read is the counterpart to the "Capture Learnings" write step.

**Red flag — `skip-recall`:** designing or fixing from scratch and either
rediscovering or contradicting settled work.

---

## Park work that never started — keep it at `draft`

**Trigger:** an issue should be paused/parked.

**Tool / semantics:** if it **never started**, leave it at `draft`. `on_hold` is
a deliberate pause for **active** work; it is not a valid target from `draft`
(and is never a way to "hold" a mechanical failure — the system reverts and
re-dispatches crashes on its own). Use `waiting` to park for a human decision and
`needs_info` when requirements are missing.

**Red flag — `on_hold-from-draft`:** trying to `on_hold` an issue that never
left `draft`.

---

## Finished a hand-fix outside the pipeline — close the loop

**Trigger:** you fixed something by hand (a quick edit, a console action) that
the pipeline didn't drive.

**Tool / semantics:** drive the corresponding issue through its `status` so the
pipeline reflects reality, and/or capture a `forge_memory` learning so the next
agent benefits. Work that lands without a status move or a recorded learning is
invisible to everyone after you.

**Red flag — `fix-by-hand-and-forget`:** applying a fix and leaving no status
move and no learning.

---

## See also

- **Step handoffs** — `forge_step_handoff.write` passes structured context
  (`filesModified`, `decisions`, `verdict`, …) to the next pipeline step.
- **Skill facts / variables** — fixed Forge process knowledge is injected from
  the facts registry; skills reference contextual facts by `{{forge:<id>}}` and
  project guides by `{{project:<key>}}` instead of copy-pasting.
- **Pipeline rules & status discipline** — the always-injected `pipeline-rules`
  preamble (status LAST, branch discipline, decompose is system-owned).

---

## Forge red flags

A quick checklist — if you catch yourself doing one of these, reach for the
affordance above instead:

- **`prose-deps`** — encoding an issue dependency in prose instead of a `blocks` edge.
- **`open-as-note`** — filing a note/follow-up at `open` (spawns a pipeline run) instead of `draft`.
- **`wholesale-config-clobber`** — patching a nested config map without reading it first.
- **`skip-recall`** — designing/fixing without `forge_memory.search` for prior work.
- **`on_hold-from-draft`** — `on_hold` on an issue that never started (use `draft`/`waiting`).
- **`fix-by-hand-and-forget`** — a hand-fix with no status move and no captured learning.
