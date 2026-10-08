## Memory & knowledge

Forge separates durable context into three tiers, each with a different job:

- **`forge_memory`** — per-project semantic search over accumulated notes, decisions, fix-patterns, policies. Not auto-loaded into any prompt; you recall it deliberately. `search({ projectId, query, topK, sourceFilter? })` returns scored hits; `write({ projectId, source, sourceRef, textContent, metadata? })` upserts on the natural key `(projectId, source, sourceRef)` — reusing a `sourceRef` refines the existing entry instead of duplicating it.
- **`forge_knowledge`** — curated, structured knowledge entries (overview / workflow / rule / reference kinds) with an explicit `injection` policy (`always` / `on_demand` / `none`). This is the project's authored knowledge base, distinct from the free-form memory stream.
- **`forge_knowledge` with `injection: always`** — entries rendered verbatim into every pipeline preamble for this project, as against `on_demand`, which reaches the prompt as a slug the agent fetches when it needs the text.

### Recall-first discipline
Before you design, reproduce, or fix something non-trivial: recall what prior work already established for the area you're about to touch, so you neither contradict a settled decision nor rediscover it from scratch. Run one or two focused queries on the concrete nouns of the task — a generic query on the whole project wastes a call and returns noise.

### Verify at recall — the loop that keeps memory clean
A memory hit is point-in-time. Once you've checked it against the live code:
- If it still holds → report `forge_memory.feedback({ ..., verdict: 'confirmed' })`. This protects the entry from decay.
- If it's been superseded → report `verdict: 'outdated', evidence: '<what disproved it>'`. This archives it immediately instead of letting the next agent trip over the same stale claim.
A verification you silently do but never report is a cleaning signal thrown away — the entry stays stale for the next reader.

### Capturing a new lesson
Only when it's reusable by a *different* agent on a *different* issue — a convention, a non-obvious gotcha, a fix pattern. Issue-specific detail belongs in that issue's `sessionContext`, not memory. Search first (`sourceFilter: ['knowledge']`) before writing, to avoid duplicating an existing entry under a different `sourceRef`.