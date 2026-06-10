# Memory v2 — Cognitive Layer (forge-agents parity)

**Status:** Draft
**Target:** v0.2 (Phases 0–2) → v0.3 (Phases 3–4) → later (Phase 5)

The `forge-agents` predecessor (`~/ai-project/forge-agents`, Strapi + Qdrant) implemented a full *cognitive* memory system: memories were extracted, deduplicated, usage-tracked, consolidated, and pruned over time. The forge rewrite kept the storage layer (better engineered: typed, authz'd, relational) but dropped the learning loop — today memory only accumulates. This proposal ports the predecessor's strengths onto forge's architecture.

## What forge-agents implemented (full inventory)

| Capability | Where (forge-agents) | How it worked |
|---|---|---|
| Hybrid retrieval | `services/agent/retrieval-strategy.ts`, `embeddings/multi-search.ts` | 5 strategies: `semantic` (dense), `keyword` (BM25 sparse + entity index + scroll fallback), `graph` (KG traversal), `hybrid` (RRF fusion, k=60, α=0.7 dense weight), `auto` (intent classifier → strategy) |
| Cross-encoder rerank | `embeddings/cross-encoder.ts` | Optional rerank of top-K via LiteLLM (`LITELLM_RERANK_MODEL`); native `/rerank` for cohere/jina/voyage, LLM fallback otherwise; 5-min result cache |
| Contextual embeddings | `embeddings/contextual-prefix.ts` | Anthropic contextual-retrieval pattern: fast model generates a 1–2 sentence per-chunk prefix before embedding |
| Semantic dedup on write | `agent/memory/crud.ts` | Before insert, search similar; cosine > 0.85 → overwrite the existing memory instead of duplicating |
| Usage tracking | `crud.ts` `touchMemories` | `retrievalCount` incremented on every search hit (fire-and-forget) |
| Deterministic decay | `agent/memory-lifecycle.ts` | Prune: `retrievalCount=0 && age>30d`, or `retrievalCount<3 && updated>90d`; also invalidates KG edges pointing at closed/missing issues |
| LLM fact extraction | `agent/memory/extraction.ts` | Post-conversation: heuristic gate (correction patterns incl. Vietnamese, length) → fast-model prompt ("would knowing this change a FUTURE conversation?") → max 3 facts + 3 KG edges; categories preference/correction/convention/tool_pattern; also captured working GraphQL patterns from successful tool calls |
| Dream consolidation | `services/memory-dream/` | Per project every 24h: gather signal (AI skill comments, status changes, **reopen cycles** = highest-value signal) → LLM proposes CREATE/UPDATE/PROMOTE/PRUNE with hard caps (5/5/3/10) → execute → log as activity |
| Role/visibility | `agent/memory/types.ts` | 8-role hierarchy (ceo→devops), up/down/same/all visibility, per-pipeline-skill read scopes |
| Scopes | `crud.ts` | user / project / global (`__global__` cross-project memories) |
| Degraded writes | `crud.ts` `storeWithoutEmbedding` | Embeddings down → store with zero dense vector + BM25 sparse so the memory stays keyword-searchable |
| MEMORY.md export | `agent/memory/search.ts` | `forge_memory sync` action renders memories as Claude Code-compatible MEMORY.md markdown |
| Retrieval analytics | `agent/strategy-analytics.ts` | Per-query: strategy, latency, result count, top score, resolved strategy |

## What forge already has (don't rebuild)

- Storage with real authz, natural-key upsert dedup (exact-key), HNSW index, typed services shared REST/MCP.
- `knowledge_edges` table **with temporal validity + confidence + sourceMemoryId** — schema parity with forge-agents' KG edges already exists; only extraction and graph retrieval are missing.
- A working domain-specific learning loop: CI fix patterns (`reopen → developed` → pattern memory → auto-injection into forge-code payloads) with per-type caps. This is the template for Phase 4's signal gathering — forge's `transition` hook already carries `reopenCount`.
- Step handoffs (own table), knowledge ingest, prompt-facts instructing agents to search-then-write conventions.

## Deliberate non-goals (dropped on purpose)

- **Role/visibility hierarchy** — forge's enforced project-membership + `source` enum model is simpler and actually checked at every surface; forge-agents' role filter was advisory (the HTTP layer accepted a bare `projectDocumentId` with no membership check). If skill-scoped reads are ever needed, express them as `sourceFilter` presets per pipeline stage, not a parallel ACL.
- **Hard-delete by LLM** — consolidation prune becomes *archive* (soft delete), never row deletion. forge-agents let the LLM call `removeMemory` directly; that's a data-loss risk caps only mitigate.
- **`setInterval` pollers** — all scheduled work goes through pg-boss (already running).

## Phases

### Phase 0 — Hygiene (prerequisites, from the 2026-06 review)

1. Delete `source:'issue'` memory rows when an issue is hard-deleted (add cleanup in `issueRoutes.delete`, mirroring the pm-policy delete handler).
2. Store full `textContent` (≤100k), truncate only the string passed to `embed()` — stop discarding data.
3. Classify indexer errors via `instanceof EmbeddingUnavailableError`, not message substring.
4. Boot assertion: `env.EMBEDDINGS_DIM === MEMORY_EMBEDDING_DIM`.
5. Rate-limit `POST /api/memory` and `/api/memory/search` (existing middleware).
6. Schema: add `retrieval_count int default 0`, `last_retrieved_at timestamptz`, `archived_at timestamptz` (used by Phases 2 and 4); make `embedding` nullable for Phase 1's degraded writes.

### Phase 1 — Retrieval strength (highest value-per-effort)

- **Keyword search via Postgres FTS** — generated `tsvector` column on `text_content` + GIN index; `websearch_to_tsquery` ranking. No new infra (replaces Qdrant BM25 sparse vectors).
- **Hybrid strategy with RRF** — port `reciprocalRankFusion` (k=60, weighted dense/keyword) into `memory/search.ts`; run dense + FTS in parallel.
- **`strategy` param** (`semantic | keyword | hybrid`, default `hybrid`) on `POST /api/memory/search` and `forge_memory.search`; same service function for both, per existing convention.
- **Degraded writes** — embeddings down: store the row with NULL embedding (FTS still works), pg-boss backfill job re-embeds rows where `embedding IS NULL` or `embedded_at < updated_at`. Kills the current 503-hard-fail.
- **Optional cross-encoder rerank** — port `cross-encoder.ts` behind `EMBEDDINGS_RERANK_MODEL` env; off by default.
- Defer: contextual chunk prefixes (only pays off for long-document knowledge ingest; revisit with chunking).

### Phase 2 — Learning loop foundations

- **Usage tracking** — single `UPDATE ... SET retrieval_count = retrieval_count + 1, last_retrieved_at = now() WHERE id = ANY($hits)` after each search (one statement, not forge-agents' N+1 scroll loop). Exclude `forge_memory.get` natural-key reads.
- **Semantic dedup on write** — for agent-curated sources (`note`, `knowledge`): before insert with a *new* sourceRef, search top-5; hit > 0.85 → upsert onto the existing row (return `{dedupedInto}` so the caller knows). Mirror forge-agents threshold; make it metadata-overridable.
- **Deterministic decay** — pg-boss cron per project: archive (`archived_at = now()`) rows with forge-agents' rules (`retrieval_count = 0 && created > 30d`, `retrieval_count < 3 && updated > 90d`) — **only** for `note`/`knowledge`; never `issue`/`decision`/`policy` mirrors (their lifecycle belongs to their source records). Archived rows excluded from search; purge after a further 90d.

### Phase 3 — Extraction

- **Session-end fact extraction** — on `jobCompleted` hook: heuristic gate (port `hasMemoryWorthyContent` incl. Vietnamese correction patterns) → fast-model extraction prompt (port verbatim — the good/bad examples are battle-tested) → ≤3 facts written via `indexMemoryBestEffort` as `source:'knowledge'` with `metadata.category` ∈ preference/correction/convention/tool_pattern, `metadata.origin:'extraction'`. Feed existing memories into the prompt as dedup context.
- **Edge extraction** — same pass emits ≤3 subject/predicate/object triples into the existing `knowledge_edges` table (`sourceMemoryId` ← the memory row).
- **Tool-pattern capture** — successful repeated tool-call shapes stored as `category:'tool_pattern'` (forge equivalent: MCP tool sequences, not GraphQL).

### Phase 4 — Consolidation ("dream", adapted)

- pg-boss cron (daily, per project, concurrency-guarded):
  1. **Signal**: reopen cycles (from `transition` hook data / activity log — highest value), recent agent comments, status changes — forge already records all three.
  2. **LLM proposes** CREATE / UPDATE(merge) / ARCHIVE with hard caps (port 5/5/10; drop PROMOTE — no role hierarchy).
  3. **Execute** against `note`/`knowledge` rows only; archive instead of delete; validate every sourceId against the project (port the `validSourceIds` guard).
  4. **Log** a `decision` memory row + activity entry summarizing actions (audit trail).
- Decay pruning (Phase 2) runs in the same job, after consolidation.

### Phase 5 — Graph retrieval & global scope (later)

- `graph` strategy: query → entity extraction → traverse `knowledge_edges` (respect `validUntil`) → resolve `sourceMemoryId` rows; add pagerank-weighted ranking if edge volume justifies it.
- `auto` strategy (intent → strategy map) once usage analytics show which strategies win per query class.
- Org-scoped memories (forge-agents' `__global__`) — needs an authz story first (org membership ≠ project membership); explicitly out of scope until then.
- MEMORY.md export for runner devices (`forge_memory.sync` equivalent) — pairs with runner-side CLAUDE.md/MEMORY.md conventions.

## Sequencing rationale

Phase 1 improves every read immediately and unblocks degraded writes. Phase 2 is the prerequisite for any pruning/consolidation (you can't decay what you don't measure). Phases 3–4 are the actual "gets smarter over time" loop and depend on 2. Phase 5 is leverage on top, gated on real usage data.

## Open questions

- Dedup threshold 0.85 was tuned on forge-agents' embedding model; re-validate against `text-embedding-3-small` before enabling by default.
- Should extraction (Phase 3) run on every `jobCompleted` or only pipeline-terminal jobs? Cost vs coverage — start terminal-only.
- Consolidation model tier: forge has cost-aware-model-routing proposed; dream runs should use the cheap tier.
