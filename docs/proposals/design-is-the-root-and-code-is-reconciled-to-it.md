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
- [ ] Requirements (REQ-n with BCs), approved workflow designs and patterns
      (`docs/conventions/domain-entities.md`, the ADRs, ports and adapters) are named as the root.
- [ ] Every workflow names the requirements it serves.

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

## Honest costs

| What adopting this costs | The price |
|---|---|
| Old code is thrown away | A node rewritten instead of patched loses whatever its old code handled that the design never stated; that loss is accepted on dev and surfaces as a new marker, not as a guarded regression. |
| Observation is a second model of the code | The observed layer is only as true as the agent that drew it; until re-observation is cheap it goes stale like any document. |
| Markers depend on traceability that is partial today | Step-level links (feedback on a step, BCs naming steps) do not all exist yet, so the first markers are coarser than the design shows. |
