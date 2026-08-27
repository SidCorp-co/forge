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

## It turns out not to be work — route it yourself

**Trigger:** you are working an issue (or just reading one) and it fails the
admission test — it is a note, a question, a duplicate, or something already
done. See [what-is-an-issue.md](what-is-an-issue.md) for the four gates.

**Tool / semantics:** you are the cheapest person to fix it, because you have
just read it. **Comment first** — name the gate it fails and where the content
went (the memory entry, the `docs/proposals/` file, the issue it duplicates).
**Then move it:** `needs_info` when a human owes you requirements and it could
still become real work, or `closed` when it is not work at all. There is no
route back into `draft` — nothing transitions into `draft`, by design.

**Closing non-work needs `unmark`.** `closed` auto-stamps `merged_at`, and that
stamp releases every `blocks` dependent as if the work had shipped. Call
`forge_issues action=unmark` right after.

**Red flag — `close-without-unmark`:** closing an abandoned or note-shaped issue
and leaving the auto-stamp, silently unblocking work that is still blocked.

---

## A bug you find while working — fix it, don't file it

**Trigger:** while working an issue you hit a defect, gap or missing check that
the plan never mentioned.

**Tool / semantics:** **fix it in this issue**, then DECLARE it under
`Extra fixes:` in your comment — one line per fix, naming the file and what was
wrong. Declaring is what makes it authorized rather than scope-creep: review
judges a declared extra fix on its merit like any other code, and is told never
to send work back for fixing a real bug it found on the way.

**Red flag — `file-instead-of-fix`:** filing a fixable defect as a new issue
instead of fixing it. Measured 2026-08-18 on forge-dev: 30 open `draft`s, the
oldest untouched for 54 days, most of them defects a stage deferred rather than
fixed — including ISS-791 and ISS-845, which describe drafts being filed and
forgotten while themselves sitting filed and forgotten.

---

## A residual genuinely out of reach — three homes, and none of them is a new issue

**Trigger:** something you cannot resolve inside the work you are doing — a
human decision, or work no diff here can carry.

**Tool / semantics:** exactly one of — a **`blocks` edge** onto the issue that
would otherwise ship without it · a line in **`docs/proposals/`** for a decision
awaiting sign-off · **`waiting`** + `waitingKind` + `reason` when it blocks THIS
issue. If none of the three fit, say it in a comment on the issue you are
already on.

Both directions of this have cost real damage. Four stages once flagged an
unauthenticated data leak, each asked for a follow-up, none was filed, and it
shipped — so silence is not the safe option. But filing was the wrong
correction: a new unowned `draft` is not a hand-off, it only moves a residual
from silently-lost to silently-parked.

**Red flag — `silent-nonwork`:** dropping a residual entirely, or parking it as
an unowned `draft` instead of one of the three homes.

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
- **`draft-as-note`** — filing a note, log, question or record as an issue at all; `draft` hides it, it does not make it appropriate.
- **`close-without-unmark`** — closing non-work and leaving the `merged_at` auto-stamp, which unblocks dependents as if it had shipped.
- **`silent-nonwork`** — dropping a residual, or parking it as an unowned `draft` instead of a `blocks` edge / a `docs/proposals/` line / `waiting`.
- **`file-instead-of-fix`** — filing a defect you could have fixed in the issue you are already working, instead of fixing it and declaring it under `Extra fixes:`.
