# Design is the root, and code is reconciled to it

**Removed when:** every phase below is checked off on the pilot workflow and on the remaining
forge workflows, and the reconciliation flow runs from the product (observed layer, markers,
decisions) rather than from this page. The run that ticks the last box deletes this file in the
same change. Tracked by ISS-120.

The owner's direction on dev, 2026-10-04: requirements, approved workflow designs and patterns are
the source of truth that Forge now builds; code may be wrong or outdated. Code is drawn onto the
workflows as an observation, marked against the design, decided node by node, and cleaned. A node
that is badly off is deleted and rebuilt to its design, not patched.

## Checklist

### Phase 0 — the root
- [x] Requirements (REQ-n with BCs), approved workflow designs and patterns
      (`docs/conventions/domain-entities.md`, the ADRs, ports and adapters) are named as the root.
      See [Phase 0 — the root list](#phase-0--the-root-list).
- [x] Every workflow names the requirements it serves: every approved design links at least one
      requirement in the product (`requirement_workflows`), read on both the requirement and the
      design. The four proposed onboarding designs link when they are approved.

### Phase 1 — the node model
- [ ] Every node carries a provenance: `planned` (approved design; reads **Upcoming** while no code
      matches it), `observed` (drawn from code, a layer that never overwrites planned), `matched`.
- [ ] The diff derives markers: planned only → **Upcoming**; observed only → **Not in design**;
      both but diverged → **Wrong**.
- [ ] Health markers sit beside them: Outdated, Needs update, Has a problem, Remove/refactor
      proposed — each derived from evidence it names, never a free-typed flag.

### Phase 2 — observe
- [ ] An observer agent reads the code of one workflow and writes its observed layer, citing a file
      and symbol for every node and edge.

### Phase 3 — decide
- [ ] Every marked node gets keep / rewrite / delete as a decision comment on its design.
- [ ] Past a stated threshold of markers or divergence the default is **Rewrite**: delete the code
      and build the node to the design.

### Phase 4 — act
- [ ] Rewrite and delete run as issues broken down from the design and land on dev continuously.
- [ ] Deleted code removes its observed node; a rewritten node is built to the planned shape.

### Phase 5 — close
- [ ] Re-observe: the node reads matched, its markers clear, its requirement's BCs earn verdicts,
      and the change ships in a dev version.

### Order
- [ ] Pilot one workflow end to end (proposed: `requirement-to-delivery`), then the rest.

## Phase 0 — the root list

Read from project forge on dev, 2026-10-04. A link is a `requirement_workflows` row
(`POST /api/projects/:id/requirements/:req/workflows`); the requirement detail lists its designs and
the design reads them back as `requirements`. Every row also answers to
`docs/conventions/domain-entities.md` (REQ-12 BC-8), so it is not repeated per row.

| Requirement | Designs it serves (approved revision) | Patterns beyond domain-entities |
|---|---|---|
| REQ-1 job given design + requirement | issue-lifecycle r3, requirement-to-delivery r2 | |
| REQ-2 status says who it waits on | issue-lifecycle r3 | |
| REQ-3 narration apart from conversation | none | gap 2 |
| REQ-4 versioned business intent | requirement-lifecycle r3, requirement-to-delivery r2, issue-lifecycle r3 | |
| REQ-5 in-project contract | requirement-to-delivery r2 | |
| REQ-6 typed verdicts | requirement-to-delivery r2, issue-lifecycle r3 | |
| REQ-7 feedback item | feedback-lifecycle r2, feedback-triage r3, requirement-to-delivery r2 | |
| REQ-8 assistant proposals wait | suggestion-lifecycle r2, feedback-triage r3, requirement-to-delivery r2 | |
| REQ-9 cross-project contract (draft) | none | no BCs yet |
| REQ-10 onboarding | project-onboarding r1 | |
| REQ-11 Development screens | requirement-to-delivery r2, issue-lifecycle r3 | ADR 0001–0005 (Releases) |
| REQ-12 one set of conventions | none: it is the pattern root itself | domain-entities.md |
| REQ-13 project's own rules | project-onboarding r1 | |
| REQ-14 Development to prototype (draft) | none | no BCs yet |
| REQ-15 Agents / Runs | agent-run-standing r1 | |
| REQ-16 Automation | automation r1 | |
| REQ-17 step health (draft) | workflow-step-health (proposed, no approved revision) | |

Links added in this pass: REQ-1, REQ-5, REQ-6, REQ-7, REQ-8 to requirement-to-delivery; REQ-4,
REQ-6, REQ-11 to issue-lifecycle; REQ-8 to feedback-triage. The ports-and-adapters ADR is not on dev
yet; it joins the pattern column when it lands.

**Traceability gaps, owed to Phase 1:**

1. Only REQ-15 and REQ-16 name design steps in their BCs, and every id they name exists in the
   approved revision. No other BC names a step, so a step marker cannot yet reach a BC.
2. REQ-3 is served by no approved design: comment intent and typed events are drawn nowhere.
3. Edges have no id. REQ-15 names edges by label (`silence.passed`, `gate.overdue`,
   `master.declared`), and issue-lifecycle draws the park and drop edges once "from any non-terminal
   status", so the 13 transitions REQ-2 BC-2 lists cannot each carry a marker.
4. REQ-7 BC-2 names `planned` and `resolved` as statuses; feedback-lifecycle r2 draws them as views,
   and draws `reopened`, which the BC does not name.
5. The new links pin nothing: their requirements were agreed before the link, so
   `pinnedRevision` is empty until a person re-pins. REQ-1 and REQ-2 pin issue-lifecycle r2 while
   r3 is approved. A re-pin flags every issue planned against the old baseline as changed since
   plan, so it is the orchestrator's decision, not done here.
6. REQ-9, REQ-14 and REQ-17 are drafts with no BCs.

## Honest costs

| What adopting this costs | The price |
|---|---|
| Old code is thrown away | A node rewritten instead of patched loses whatever its old code handled that the design never stated; that loss is accepted on dev and surfaces as a new marker, not as a guarded regression. |
| Observation is a second model of the code | The observed layer is only as true as the agent that drew it; until re-observation is cheap it goes stale like any document. |
| Markers depend on traceability that is partial today | Step-level links (feedback on a step, BCs naming steps) do not all exist yet, so the first markers are coarser than the design shows. |
