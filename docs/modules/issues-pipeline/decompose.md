# Decomposition (epic → children)

Core-owned lifecycle — skills MUST NOT hand-set parent/child status (that drift breaks the kickoff). Shipped 2026-06-01.

## Flow

| # | Phase | Mechanism (`packages/core/src`) | Effect |
|---|-------|--------------------------------|--------|
| 1 | Create | `issues/decompose.ts` `decomposeParent` | Children created at `draft` — the inert proposal state (no `STATUS_TO_JOB_TYPE` entry → never auto-dispatched). The first decomposition also parks the parent at `waiting` (the human review gate). `forge-plan` writes only the parent plan + a comment. |
| 2 | Approve | `pipeline/decomposition-subscribers.ts` `handleCascadeApprove` | A human approves the parent (`waiting → approved`) → every `draft` child flips `→ approved` and `manualHold` is cleared. The guard fires when the parent ENTERS `approved` from `waiting`/`on_hold`/`confirmed`, so a mis-set parent status can't break the kickoff. |
| 3 | Children first | (independent) | Children run their full pipelines `code → review → test → released → closed`, NOT gated on the parent. |
| 4 | Parent last | dispatch gate `decomposeChildrenPending` (`jobs/dispatch-gates.ts`) | The parent's `code`/`review`/`test`/`fix` jobs are held until EVERY decompose child has `merged_at IS NOT NULL` (a child stamps it on `released → closed`). Then the parent runs its integration work LAST → `released → closed`. |
| 5 | Cleanup | close-cascade | Parent `→ closed` cascades any non-closed child `→ closed`. |

## Invariants

- Dependency is one-way: **parent waits for children** (via `child.merged_at`) — never the reverse.
- The old `releaseDecomposePending` gate (child release waited on `parent.merged_at`) was **removed** — it deadlocked umbrella epics that never merge themselves.
- `on_hold` is NOT used for decompose parking (avoids the `on_hold → closed` dead-end); the epic waits at `approved`.
