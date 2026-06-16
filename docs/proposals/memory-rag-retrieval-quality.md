# Proposal: Memory RAG retrieval quality + write-time curation

Raise recall precision and stop stale/one-shot facts from accreting. Today retrieval is hybrid-RRF with no rerank and no index-time context; curation lives entirely in a nightly LLM job — the write path stores almost anything.

- **Status:** Draft (pre-RFC) · 2026-06-16 · research deliverable
- **Target:** v1 (rerank + write-gate) → v2 (contextual index) → v3 (bi-temporal)
- **Scope:** `packages/core/src/memory/*`, `packages/core/src/mcp/tools/forge-memory.ts`. Single-Postgres only — no graph DB, no new infra.

## Where forge already is (don't rebuild)

| Capability | Status | Anchor |
|---|---|---|
| Hybrid retrieval: pgvector HNSW (`vector_cosine_ops`) + generated `tsvector` GIN, **RRF k=60**, weights 0.7/0.3 | ✅ shipped | `memory/search.ts:141` |
| Degraded write + circuit breaker + 5-min backfill re-embed | ✅ | `indexer.ts:100`, `embeddings/client.ts:46`, `embedding-backfill.ts` |
| Semantic dedup absorb (>0.85 cosine, note/knowledge) | ✅ | `indexer.ts:112`, `:194` |
| Nightly LLM consolidation (CREATE/UPDATE/ARCHIVE) | ✅ | `consolidation.ts` |
| Deterministic decay (archive unused → purge after 90d) | ✅ | `decay.ts` |
| HNSW (not IVFFlat) | ✅ | `schema.ts:1447` |

Forge already implements the field's #1 pattern (hybrid+RRF) and a form of #3/#6 (consolidation, decay). The gaps below are the deltas vs. mem0 / Graphiti / Anthropic Contextual Retrieval (early-2026 OSS consensus).

## Gaps, ranked by leverage

| # | Gap | Evidence it bites | Field reference |
|---|---|---|---|
| 1 | **No rerank stage.** RRF top-K returned raw. | precision ceiling on near-ties | cross-encoder rerank is now standard; −67% top-20 failure (Anthropic, w/ contextual+rerank) |
| 2 | **No write-time "keep?" gate.** Any explicit `forge_memory.write` is stored; the only filter is similarity dedup. | one-shot/issue-specific facts accrete until the 30-day decay sweep | mem0 ADD/UPDATE/DELETE/**NOOP** arbitration |
| 3 | **No index-time context.** Text embedded raw, truncated to 8192 chars. | short facts lose project context | Anthropic Contextual Retrieval: −49% failure (embed+BM25) |
| 4 | **"Latest write wins" — no supersession trail.** Upsert overwrites; dedup absorbs. | stale memory mis-guided planners (audit: `web-v2-issue-detail-hidden-payload` hydrator-gap, ISS-411) | Graphiti bi-temporal edge invalidation |

## Phases

| Phase | Ships | Exit criterion |
|---|---|---|
| **v1 rerank** | Over-retrieve 50 in `runMemorySearch`, cross-encoder rerank (Voyage `rerank-2.5` / Cohere / local FlashRank) → return topK. New `EMBEDDINGS_RERANK_*` env; degrade to RRF order on rerank outage. | rerank on by default; measured nDCG@10 ↑ vs RRF-only on a held-out query set |
| **v1 write-gate** | A `shouldStore` check on `note`/`knowledge` writes: cheap heuristic first (reusability signal — see below), optional fast-model NOOP verdict. Reject → return `{stored:false, reason}` not an error. | one-shot facts (single-issue, no reusable pattern) rejected at write; decay-archive rate ↓ |
| **v2 contextual index** | Prepend a fast-model context blurb (project + source + why-this-matters) before embedding AND before the FTS column. Reuse `consolidation` LLM seam + prompt caching. | A/B: contextual vs raw embed, retrieval-failure ↓ on the v1 query set |
| **v3 bi-temporal** | Add `validAt`/`invalidatedAt`/`supersededBy`. Consolidation/dedup **invalidate** (close window) instead of overwrite/archive. Search defaults to `invalidatedAt IS NULL`; "as of T" optional. | superseded fact stays queryable + auditable; planners stop seeing stale rows |

## The write-time curation gate (v1 — answers "store or not")

Today the write path (`indexer.ts:85`) is a near-unconditional upsert — truncate → embed → semantic-dedup (>0.85 absorb, note/knowledge only) → upsert. There is no relevance/reusability gate; "is this worth keeping?" is decided **only retroactively** by the nightly consolidation LLM (`consolidation.ts:42-89`, the prompt that archives "one-time fixes with no reusable insight") and by decay (`decay.ts`, unread→archive→purge). A one-shot fact therefore lives 1–30 days and pollutes recall the whole time.

Move a *cheap* version of that judgment to write time, for `note`/`knowledge` only (lifecycle mirrors `issue`/`decision`/`policy` are exempt — they track source records 1:1):

```ts
// indexer.ts, before insert, when opts.curationGate (note/knowledge only)
//  Tier 0 heuristic (no LLM): reject if the text reads as one-shot —
//   - names a single ISS-NNN / commit sha / date as its ONLY subject, no generalization
//   - < ~40 chars of non-boilerplate signal
//   - pure status restatement ("fixed X", "merged Y") with no rule/why
//  Tier 1 (optional, fast model): NOOP | ADD | UPDATE<id>
//   - retrieve top-3 similar (already computed for dedup) → ask: new reusable
//     fact, refinement of an existing one, or not worth storing?
```

Borrow mem0's four-way verdict but keep it Postgres-local and dedup-reuse the similar-row lookup `findDedupTarget` already does (`indexer.ts:194`). The dedup search is the expensive part and it's already paid.

## Mechanism sketch

```ts
// search-service.ts — rerank stage
const candidates = await runHybrid({ ...args, topK: RERANK_CANDIDATES /*50*/ });
const reranked = rerankConfigured()
  ? await rerank(query, candidates)        // cross-encoder; degrade → candidates
  : candidates;
return reranked.slice(0, topK);

// indexer.ts — write gate (note/knowledge)
if (opts.curationGate && !degraded) {
  const verdict = await curate(input, similarTop3);   // heuristic → optional fast model
  if (verdict.kind === 'noop')   return { stored: false, reason: verdict.reason };
  if (verdict.kind === 'update') /* route into existing dedup-absorb path */;
}

// schema (v3) — bi-temporal, additive
// memories.validAt timestamptz default now(), invalidatedAt timestamptz null, supersededBy uuid null
// search default: AND invalidated_at IS NULL
```

## Deliberate non-goals

- **Graph memory** (Neo4j/Graphiti full model) — forge is single-Postgres by design. Borrow bi-temporal *columns*, not the graph.
- **Document chunking / late chunking / semantic chunking** — forge stores one embedding per curated fact, not documents. No chunking problem to solve.
- **HyDE** — risky for fact-bound identifier lookups (the keyword strategy already covers exact IDs).

## Open questions

1. Re-validate `DEDUP_THRESHOLD = 0.85` against the current embedding model — the comment (`indexer.ts:72`) flags it was tuned on the predecessor's model.
2. Rerank provider: managed (Voyage/Cohere, sub-100ms, API cost) vs local FlashRank (no egress, CPU latency). Default?
3. Write-gate Tier-1 LLM cost per write vs. the nightly batch it partially replaces — net token delta?
4. v3 migration: do existing absorbed/archived rows get backfilled `validAt`, or only new writes?

## References

- mem0 — `mem0ai/mem0`, arXiv:2504.19413 (ADD/UPDATE/DELETE/NOOP write arbitration)
- Graphiti/Zep — `getzep/graphiti`, arXiv:2501.13956 (bi-temporal invalidation)
- Anthropic Contextual Retrieval — anthropic.com/news/contextual-retrieval (−35%/−49%/−67% failure-rate reductions)
- pgvector hybrid reference — jkatz05.com hybrid-search-postgres-pgvector; AlloyDB `ai.hybrid_search()` (k=60)
- Current write path — `packages/core/src/memory/{indexer,consolidation,decay}.ts`
