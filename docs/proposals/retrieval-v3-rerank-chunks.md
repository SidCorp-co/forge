# Retrieval v3: rerank, chunked memory, relation expansion — per project, behind one flag

Status: proposed, no code written
Found: 2026-09-04, reading `forge-agents/forge/strapi/src/services/{embeddings,agent,knowledge-graph,rag-gate}` against `packages/core/src/memory/`

## What Forge has, and what it does not

`memory/search-service.ts:runMemorySearch` offers three strategies over one table. `semantic` is
cosine over `memories.embedding` (HNSW). `keyword` is `websearch_to_tsquery` over the generated
`memories.text_search` (GIN). `hybrid` runs both and fuses by Reciprocal Rank Fusion
(`memory/search.ts:reciprocalRankFusion`, k=60; dense 0.7 / keyword 0.3 until ISS-907 made them 0.5 / 0.5 — see phase 4). Every call logs a row to
`retrieval_analytics` and bumps `retrieval_count` on the hits; `decay.ts` archives unused
agent-curated rows; `feedback-service.ts` lets an agent confirm or retire a hit.

The predecessor (`forge-agents`) ran the same three plus two more and a post-step. Measured by
reading its code, not by benchmark — it kept no evaluation set either:

| forge-agents had | Forge has | Verdict |
|---|---|---|
| RRF fusion of dense + sparse | yes, ported | done |
| retrieval analytics with requested vs resolved strategy | yes | done |
| cross-encoder rerank after every strategy (`embeddings/cross-encoder.ts`: native `/rerank` for Cohere, Jina, Voyage, Together; LLM prompt otherwise; 5-min cache) | **none** | port — the largest quality lever missing |
| chunked documents, one point per chunk, a context line prefixed to each chunk before embedding (`embeddings/index.ts:upsertEmbedding`) | one vector per row, text cut at 8192 chars (`indexer.ts:MAX_EMBED_CHARS`) | port — a long issue body or knowledge entry is invisible past the cut |
| issue hits joined back to live rows and expanded one hop along relations (`chat-prompt-builder.ts:expandWithRelatedIssues`) | hits are memory rows, no expansion | port, small |
| entity index: camelCase, path segments and hyphenated terms split before matching | Postgres `english` parser, which keeps `LITELLM_API_URL` as one token | port **only if** analytics show keyword pulls weight |
| LLM intent gate choosing the strategy (`rag-gate`) | the agent chooses the tool and the `strategy` argument | do not port — one fast-model call per message for a six-row table the model already resolves by picking a tool |
| Qdrant BM25 sparse vectors | `ts_rank` | do not port — the old one never stored IDF; Postgres does |
| entity graph, 2-hop traversal, PageRank | `knowledge_edges` triple store with REST routes and no read path into search | do not port — an LLM extraction per write and a second index for a question nobody has asked yet |
| role/visibility filters, `__global__` cross-project memory, MEMORY.md export | per-project memory | not a retrieval technique; a scope decision for the owner if it ever matters |

Two things Forge does that the predecessor did not, and which this proposal must not undo: the
verify-feedback loop (`forge_memory.feedback`) and the natural-key `get` on
`(projectId, source, sourceRef)`. Every consumer of `memories` today — `get-service.ts`,
`decay.ts`, `consolidation.ts`, `candidates-*.ts`, `feedback-service.ts`, the indexer's
near-duplicate probe — assumes **one row per natural key**. The chunk design below keeps that true.

## The flag

The owner accepts migrating a project's data into a new shape for a better result, project by
project. The switch already has a home: `app_config` is the per-project runtime row
(`chatProviderId`, `retrievalTopK`, `retrievalMinScore`), read by
`chat/providers/registry.ts:resolveForProject` and written through `PUT /api/app-config/:projectId`.

Three flag columns and one status column, in one migration owned by phase 0:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `retrieval_rerank` | boolean | `false` | hybrid results pass through the reranker when the server has one configured |
| `memory_model` | text `flat` \| `chunked` | `flat` | how this project's memories are indexed and searched |
| `retrieval_expand_relations` | boolean | `false` | issue hits pull in their one-hop dependency neighbours |
| `memory_reindex` | jsonb | `{}` | state of the last flip to `chunked`: `queued · running · completed · failed · cancelled` with counts (phase 2) |

`flat` is exactly today. Nothing in this proposal changes a project that never flips a flag, and
the flags are independent: rerank works on flat or chunked; expansion works on either.

Surfaced where the other per-project knobs are: the REST PUT and the project settings page in
web-v2; `forge_config` carries `pipelineConfig`, not `app_config`, so agents flip nothing here.
Not in `projects.agent_config` — that jsonb is the pipeline's, and the affordances table already
warns about clobbering it.

## Owner decisions, 2026-09-04

Asked and answered before any code; each is a constraint on the phases below, not a preference.

| Question | Decision |
|---|---|
| Reranker model | `cx/gpt-5.6-luna`, the system-job fast model — an LLM listwise rerank, not a cross-encoder |
| Where rerank applies | agent tool calls only — MCP `forge_memory.search`, pipeline steps, chat toolsets — when the project flag is on. `semantic` is never reranked; no web UI path pays the latency |
| Reindex scope on a flip to `chunked` | `issue`, `note`, `knowledge`, `decision`, `policy`. `comment` and `job` mirrors stay flat |
| Flag defaults and permission | all three off for every project, new or existing; a project **admin** flips them; `forge-dev` is the pilot |
| Exit criterion for rerank beyond the pilot | `feedback verdict=confirmed` rate on `reranked:true` rows vs a deterministic one-in-five `rerankHoldout:true` control on the same project and window |
| Filing | all phases filed as `draft` — ISS-904, ISS-905, ISS-906, ISS-907 — with `blocks` edges on ISS-904; the owner opens them, ISS-907 only once the phase-0 evidence exists |

## Phase 0 — measure first, in the same shape the decision will be made in

**Shipped in ISS-904** (branch `iss-904`): `buildRetrievalMetadata`, `GET /api/admin/retrieval/breakdown`, migration `0203` with the four `app_config` columns, and the REST PUT/GET of the three flags.

Before any new strategy: the `retrieval_analytics.metadata` jsonb gains a per-call breakdown so
phase 4's question ("does keyword pull weight?") has an answer, and so every later phase can show
its own effect on the same rows.

```
metadata: {
  strategy, requestedStrategy,           // today
  semanticHits, keywordHits, overlap,    // new — sizes of the two ranked lists and their intersection
  reranked, rerankMs, rerankHoldout,     // phase 1 fills these
  memoryModel, expanded                  // phases 2 and 3
}
```

One admin read: `GET /api/admin/retrieval/breakdown?projectId&since` grouping those fields, so the
number is a table someone reads, not a jsonb someone greps. Ten lines in the existing
`admin/routes.ts` pattern.

Phase 0 also carries the **one migration for the flag surface**: the three `app_config` columns
above plus the `memory_reindex` status jsonb described in phase 2. Building the flags once, before
any strategy reads them, is what lets phases 1, 2 and 3 ship in any order — each reads a column
that already exists, and a flag nothing reads yet is harmless.

Files: `memory/search-service.ts` (compute in `hybridSearchMemories`, log in `logRetrieval`),
`admin/routes.ts`, `db/schema.ts` (+ migration, journal `when` = max + 86400000 per the CLAUDE.md
invariant), the `app-config` routes (expose the new columns).

Test that must go red: a unit test on `logRetrieval`'s insert payload asserting the three counts
for a planted pair of lists with one shared id. It goes red by deleting the `overlap` line.

## Phase 1 — rerank behind hybrid

**Shipped in ISS-905** (with phase 3): `memory/rerank.ts`, the required `surface` argument on `runMemorySearch`, `RERANK_MODEL`, the one-in-five holdout drawn per eligible search, and `hitIds` on every hybrid agent analytics row so the exit criterion below can be computed by joining to `memories.last_verified_at`.

**Corrected in ISS-914** (2026-09-05): the reranker is shown 1,500 characters of each candidate, not 600. On a local read-only mirror of six forge-beta projects, 40 synthetic tail-fact questions each, chunked hybrid pool 24, the same prompt at 600 vs 1,500 gave hit@1 58→65, 43→65, 38→50, 50→70, 58→65 and 50→63, and the reranker demoting the true hit fell from 8/13/11/8/10/9 cases to 3/5/8/2/7/2.

**Corrected in ISS-913** (2026-09-05): the reranker is shown the passage that matched (`matchedChunk.text`) on a chunked project, not the row head, and its cache key hashes that text. Measured before the fix on forge-beta: with RRF alone the exact-passage hit was rank 1 on every pass; reranked, forge-dev dropped a 75k-character hit out of the top 8 in 2 of 4 passes and forge-plugin demoted two rank-1 hits to 4 and 5 — the model was judging a document by its first 600 characters while the query matched passage 76.

**Model — owner decision 2026-09-04: the reranker is `cx/gpt-5.6-luna`**, the system-job fast
model, not a native cross-encoder. That changes the client: there is no `/rerank` wire to call, so
the rerank is one **listwise** chat completion through `memory/llm.ts:callFastModel`, the same
plumbing the auto-title and extraction jobs use (`LITELLM_FAST_MODEL`, `reasoning_effort` from
`LITELLM_FAST_REASONING_EFFORT`, the two-round-trip retry guard already measured on luna). No new
env vars: `RERANK_MODEL` is an optional override that defaults to the fast model, and rerank is
"configured" exactly when `fastModelConfigured()` is true.

**Prompt**, new `memory/rerank.ts`: the query, then the candidates as numbered blocks of at most
600 characters each (chunked-mode hits send their `matchedChunk`, flat hits the head of
`text_content`), then one instruction — return a JSON array of the candidate numbers ordered
most-relevant first, omitting any that do not bear on the query. One call scores every candidate;
`topK` is applied locally. `max_tokens` is sized from the candidate count (about 4 tokens per
number plus brackets), which is what the `reasoning_effort` control exists for. Output is parsed
defensively — the OpenAI wire on this proxy has returned prose where JSON was asked for
(measured 2026-09-04) — and anything unparsable, any number outside the range, or a timeout keeps
the RRF order and logs `reranked:false`. Omitted candidates are appended after the ranked ones in
RRF order, never dropped: the model's omission is a ranking claim, not a filter.

Pointwise scoring (one call per candidate) is rejected: 50 calls per search against a paid model,
for a gain the listwise form already captures at this candidate count.

**Hook**, in `search-service.ts`. `runMemorySearch` gains a required `surface: 'agent' | 'web'`
argument so the owner's "agent tool calls only" decision is enforced where the strategy runs, not
hoped for at the call sites: `mcp/tools/forge-memory.ts`, the chat toolset registry and the
pipeline callers pass `agent`; `memory/search-routes.ts` (`POST /api/memory/search`, what web-v2
and any browser client hit) passes `web` and is never reranked. Rerank runs only for
`strategy:'hybrid'`, `surface:'agent'`, the project's `retrieval_rerank` true and a fast model
configured: fuse `3 × topK` candidates (cap 50), rerank,
return `topK`. A reranked hit keeps its RRF `score` (an LLM emits an order, not a calibrated
score) and gains `rerankPosition`; the response carries `reranked: true` and the order is the
model's. `semantic` is untouched — its cosine
scores are what the knowledge dedup fact and the near-duplicate probe threshold on, which is the
same reason hybrid did not become the default in phase 1 of memory-v2.

**Cache**: 5-minute in-process LRU of 500 entries. Every candidate is ranked in the one call and
`topK` is applied locally, so the cached value is the complete ordering of the submitted set that
no later `topK` can truncate. The key is `sha256(model | query | ids in submitted order | sha256
of each document text)`, so two calls with the same ids in a different order, or the same id whose
text changed, never share an entry. (The predecessor keyed on sorted ids and let `top_n` vary; the
review of this proposal caught that a smaller `topK` would then read a result with the wrong
count.) The cache exists because an agent retries the same query with a different `topK` inside
one turn.

Files: `config/env.ts` (optional `RERANK_MODEL`), `memory/rerank.ts` (+ test), `memory/search-service.ts`,
`mcp/tools/forge-memory.ts` (description gains one sentence), `knowledge/unified-search.ts`
(passes the flag through). No migration — the flag column landed in phase 0.

Tests that must go red:
- unit: a fake fast model returning `[3,1,2]`; assert the hits follow it and carry
  `rerankPosition`. Red by returning RRF order.
- unit: the fake returns prose, then `[9]` (out of range), then a 503; each case asserts RRF
  order, `reranked:false`, no throw. Red by rethrowing or by dropping the range check.
- unit: the fake omits one candidate; assert it is appended last, not dropped. Red by filtering.
- integration (container Postgres, `tests/integration/`): two planted memories where the
  RRF order and the reranker's order disagree; flag off → RRF order, flag on → reranker order.
  Red by ignoring the flag.

**Holdout**: with the flag on, one eligible call in five is not reranked and is logged
`rerankHoldout:true`. The draw is random per eligible search (`rerank.ts:inRerankHoldout`), not the
`hash(analytics row id) % 5` this section first proposed: the analytics row is inserted after the
search returns, so its id does not exist when the decision is needed, and a retry of the same query
landing in the other arm is accepted — the comparison is between arms over a week of rows, not
between paired searches. Without a holdout the flag makes every eligible call reranked, and the only
`reranked:false` rows left would be failures and ineligible strategies, which is not a control group
(the review of this proposal caught that).

Exit criterion for the pilot on `forge-dev`: over one week, the `feedback verdict=confirmed` rate
of `reranked:true` rows exceeds that of `rerankHoldout:true` rows on the same project and window.
That rate is the one quality signal Forge already collects. Attribution rule, since feedback lands
on the memory row and not on the search: a search counts as confirmed when at least one id in its
`hitIds` has `memories.last_verified_at` inside the 24 hours after the search's `created_at`; a
memory returned by both arms inside that window counts for both, and the collision rate is reported
next to the two rates so a week where it dominates is read as inconclusive rather than as a win.
The holdout is removed when the flag graduates from pilot, by the same issue that flips the other
projects.

## Phase 2 — the chunked memory model

**Shipped in ISS-906** (branch `iss-906`), backend only: migration `0205` (`memory_chunks`,
`memories.chunk_generation`, `memories.chunked_at`), `memory/chunker.ts`, `memory/chunk-writer.ts`,
`memory/chunk-reindex.ts`, the chunked write path in `indexer.ts`, `runChunkBackfill`, the UNION
read in `search.ts:chunkedSearch`, and the four memory-model endpoints (five operations — the POST takes both `chunked` and
`flat`) in `app-config/memory-model-routes.ts`. Two departures from the text below, both recorded here so the
text is not read as the code: the context prefix for `knowledge` is `Knowledge <ref> (<category>)` and
for `note` / `decision` / `policy` it is `<Source> <ref>` — the row does not know its author's role,
and the issue prefix is the only one with a title; and the `queued` state a flip writes is sized by
`countPending`, not the estimate, so a resume after cancel or failure shows `done` for the rows
already chunked. `memoryModel` was removed from `PUT /api/app-config` in the same change: the flip
has a job behind it and only the POST below may start one. **The Project Settings card that draws
the five states is split out as ISS-908** (a screen change parks for human review; the backend
does not), blocked on this issue. The settings-page passages below shipped separately in ISS-908 (the Memory tab); everything below is code.

### Shape

A **sibling table**, not a change to `memories`' key:

```
memory_chunks
  id             uuid pk
  memory_id      uuid  → memories.id  ON DELETE CASCADE
  chunk_index    int
  text_content   text          -- the chunk, WITHOUT the prefix
  context_prefix text          -- what was prepended before embedding
  embedding      vector(1536)  -- HNSW cosine, same dim as memories
  text_search    tsvector GENERATED (to_tsvector('english', context_prefix || ' ' || text_content))  GIN
  generation     int           -- copy of memories.chunk_generation when this set was written
  unique (memory_id, chunk_index)

memories
  + chunk_generation int not null default 0   -- bumped on EVERY write to a chunked-project row
  + chunked_at       timestamptz              -- NULL = no complete chunk set for the CURRENT generation
```

`memory_chunks.generation` is stamped from the parent's `chunk_generation` at write time, and the
search arm joins on equality. That join is the whole staleness defence: a chunk set from a
previous generation is invisible the moment the parent is rewritten, whether or not the new set
ever lands.

`memories` keeps its row, its natural key, its whole-document `embedding` (still cut at 8192, still
what the near-duplicate probe compares against) and its `text_search`. Every consumer that reads
one row per key is unchanged. Only search learns about chunks.

### Chunker

`memory/chunker.ts`, pure: split on paragraph breaks, then sentences, into ~1,200-character
pieces with 200 characters of overlap; a document under 1,500 characters is one chunk. Prefix per
chunk from a template on `source`: issue → `Issue ISS-<n> "<title>" · <priority> · <category>`;
knowledge → `Knowledge "<title>" (<kind>)`; note/decision/policy → `<source> by <role or device>`.
No LLM-written prefix in this phase (priced below). Mirrors `upsertEmbedding`'s
`buildContextPrefix` in the predecessor.

### Write path

One constant, `memory/chunker.ts:CHUNKED_SOURCES = ['issue','note','knowledge','decision','policy']`,
is the only place the owner's scope decision lives. The write path, the estimate and the reindex
job all filter on it, so a `comment` is never chunked on write, never counted in an estimate and
never walked by the job — the review of this proposal caught the three paths naming the set
separately.

`indexer.ts:indexMemory`, when the project's `memory_model` is `chunked` **and** `input.source` is
in `CHUNKED_SOURCES`, becomes three steps with the network call outside both transactions:

1. **Invalidate**, in the same transaction as the parent upsert: `chunk_generation = chunk_generation + 1`,
   `chunked_at = NULL`, `DELETE FROM memory_chunks WHERE memory_id = …`. Read back the new
   generation `g` and the text that was written. From this commit on, the row is searched through
   its flat arm only — the review of this proposal found that without this step a failed re-embed
   left the previous chunks searchable beside the updated flat row, returning content the
   parent no longer says.
2. **Embed**: chunk the text read in step 1, `embedBatch` the prefixed chunks
   (`embeddings/client.ts:embedBatch` exists). A degraded embed (`EmbeddingUnavailableError`)
   stops here; the row stays flat-only with `chunked_at IS NULL` and the backfill picks it up.
3. **Publish**, one transaction: `INSERT memory_chunks … generation = g`, then
   `UPDATE memories SET chunked_at = now() WHERE id = … AND chunk_generation = g`. If a concurrent
   write bumped the generation between steps 1 and 3 the guard matches nothing, the inserted
   chunks carry a generation the search join never selects, and the concurrent write's own step 1
   has already deleted or will delete them. Nothing obsolete is ever published.

`embedding-backfill.ts` gains a second query: memories in chunked projects with `chunked_at IS
NULL`, oldest first, batch 50, each processed through steps 2 and 3 with the generation read at
select time.

### Migration of existing data — an operation the owner sees, not a flag that runs a job

The flip is hours long on a large project and costs money, so it is a small state machine with
its own endpoints, not a side effect of `PUT /api/app-config`:

| Endpoint | What it does |
|---|---|
| `GET /api/app-config/:projectId/memory-model/estimate` | `{ memories, totalChars, estimatedChunks, estimatedEmbedCalls, estimatedMinutes }` from one `SELECT count(*), sum(length(text_content)) … WHERE source IN CHUNKED_SOURCES` and the chunker's constants. The settings page shows this **before** the confirm button; nothing is enqueued |
| `POST /api/app-config/:projectId/memory-model` `{ model: 'chunked' }` | sets `memory_model`, writes `memory_reindex = { state:'queued', total, done:0, requestedAt }`, enqueues one pg-boss job `memory-chunk-reindex` for the project (same registration shape as `MEMORY_EMBED_BACKFILL_QUEUE`). 409 if a reindex is already `queued` or `running` |
| `GET /api/app-config/:projectId/memory-model/reindex` | the `memory_reindex` jsonb: `state` ∈ `queued · running · completed · failed · cancelled`, `total`, `done`, `remaining`, `lastError`, `startedAt`, `finishedAt`, `lastBatchAt` |
| `DELETE /api/app-config/:projectId/memory-model/reindex` | sets `state:'cancelled'`; the job checks the state before every batch and exits. Completed rows stay chunked and searchable |
| `POST /api/app-config/:projectId/memory-model` `{ model: 'flat' }` | cancels a live reindex the same way, switches the read path immediately, and enqueues the chunk deletion for seven days later |

The job walks the project's memories with `source IN CHUNKED_SOURCES AND chunked_at IS NULL` in
batches of 50 through steps 2 and 3 above, updating `done` / `remaining` / `lastBatchAt` after each batch so the settings page
shows a moving number, not a spinner. An `EmbeddingUnavailableError` sets `state:'failed'` with
`lastError` and stops; a **Retry** on the page re-POSTs and the job resumes from the rows still
`chunked_at IS NULL` — it is idempotent and resumable by construction, so a server restart
mid-run is the same case. `last_backfill_at` (a column that exists and nothing writes today) is
stamped on `completed`.

The settings page — **shipped in ISS-908** as the Memory tab of Project Settings — therefore has five states to draw: *flat* (estimate + confirm), *queued /
running* (progress with counts and Cancel), *failed* (error + Retry), *completed*
(chunked, with the flat option offered), *cancelled* (partial, with Resume). A project whose
reindex never finished is still correct to search — the UNION read below is what makes that
true — so none of these states is an outage.

The pending `memory_reindex` jsonb travels on the same `app_config` row the other flags use and
is the reason that row's column is added in phase 0 with them.

### Read path, safe mid-migration

In `search.ts`, when the project is `chunked`:

- semantic: `SELECT c.memory_id, MIN(c.embedding <=> q) FROM memory_chunks c JOIN memories m ON
  m.id = c.memory_id AND m.chunked_at IS NOT NULL AND c.generation = m.chunk_generation … GROUP BY
  c.memory_id` **UNION** the flat query restricted to `chunked_at IS NULL`, ordered by distance,
  limit topK. The join is not optional: it is what makes a superseded chunk set unreachable.
- keyword: the same join with `MAX(ts_rank(...))`, UNION the flat query on `chunked_at IS NULL`,
  ordered by rank.
- hydrate hits from `memories`; the hit gains `matchedChunk: { index, text }` so an agent sees the
  passage that matched instead of the first 8192 characters.

So a project that flipped a minute ago searches its already-chunked rows by chunk and everything
else the old way, with no gap. Flipping back to `flat` switches the read path immediately; the
`memory_chunks` rows are left in place for a week by the same job, then deleted, so an accidental
flip costs nothing.

Files: `db/schema.ts` (+ migration for `memory_chunks` and the two `memories` columns, journal
`when` = max + 86400000 per the CLAUDE.md invariant), `memory/chunker.ts` (+ test),
`memory/indexer.ts`, `memory/embedding-backfill.ts`, `memory/chunk-reindex.ts` (+ test),
`memory/search.ts`, `memory/search-service.ts`, the `app-config` memory-model routes (+ test),
`docs/modules/knowledge-memory-skills/README.md`; the web-v2 Memory tab shipped in ISS-908.

Tests that must go red:
- unit, chunker: a 5,000-character body yields chunks each ≤ 1,400 characters with the seam text
  present in two neighbours; a 900-character body yields one. Red by dropping the overlap.
- integration: a 6,000-character issue body whose last paragraph alone contains `zanzibar`;
  `flat` → the semantic hit scores ~0 (the whole-document vector is the head of the text) and the
  keyword arm finds it only because `text_search` covers 100,000 characters; flip → reindex → both
  hit through the last passage, `matchedChunk.index` is the last chunk. Red by cutting the reindex.
  (`tests/integration/memory-chunked-e2e.test.ts`, with a fake embedding that reads the first 2,000
  characters.)
- integration: flip with a planted degraded row (`embedding IS NULL`); the reindex leaves
  `chunked_at` NULL for it and the next backfill tick completes it. Red by setting `chunked_at`
  unconditionally.
- integration, staleness: a chunked memory whose last chunk alone says `zanzibar`; rewrite the
  parent without that word while the embeddings fake returns 503; a `zanzibar` query returns
  nothing. Red by dropping the generation join or the step-1 delete.
- integration, the flip as an operation: `estimate` returns counts matching a planted corpus;
  `POST chunked` returns 409 while a run is live; `DELETE` stops the job between batches and the
  status reads `cancelled` with `done < total`; a second `POST` resumes and reaches `completed`.
  Red by removing the per-batch state check.
- integration: mid-migration read — two memories, one chunked one not; a query that matches each
  returns both. Red by dropping the UNION arm.
- existing: `get-service`, `decay`, `consolidation`, `feedback` suites unchanged and green — the
  assertion that one row per key still holds.

## Phase 3 — one-hop relation expansion

**Shipped in ISS-905** (with phase 1): `memory/expand-relations.ts`, walking `blocks` and `blockedBy` edges of kind `blocks` / `relates`, unexpired only, on both surfaces; `expanded` / `expandedCount` on the analytics row.

`runMemorySearch` gains `expandRelations?: boolean` (default from the project flag). After
ranking, for each hit with `source:'issue'` — at most the top 5 — load its `blocks` / `relates`
neighbours with `issues/dependency-read.ts:loadIssueRelations`, look up their `memories` rows by
natural key `('issue', <issueId>)`, and append the ones not already in the list with
`score: 0` and `via: { relation: <kind>, from: <ISS-n> }`. They are appended after the ranked hits,
never interleaved: the ranking is the retriever's claim, the expansion is a courtesy. `topK` bounds
the ranked part; expansion adds at most `topK` more.

The predecessor did this inside the chat prompt builder. Forge has no injected RAG — the agent
calls `forge_memory_search` as a tool (`chat/tools/registry.ts`) — so the expansion lives in the
service where every caller gets it.

Files: `memory/search-service.ts`, `mcp/tools/forge-memory.ts`, `knowledge/unified-search.ts`.

Test that must go red: integration — issue A blocks issue B, only A matches the query; flag off →
one hit; flag on → two, B carrying `via.relation:'blocks'`. Red by returning before the expansion.

## Phase 4 — identifier-aware keyword matching, only with evidence

**Shipped in ISS-907** (2026-09-05). The evidence arrived a different way than the gate below expected: a search-quality trial on a local read-only mirror of six forge-beta projects (60 live-log queries, 40 synthetic tail-fact questions and up to 30 identifier lookups per project) showed identifier lookups landing in the top 8 on 20–53% of queries, and every zero-hit search on forge-dev and forge-plugin in 14 days was a keyword search for a path or identifier. It also showed a second cause the phase had not named: RRF at 0.7 / 0.3 with k=60 scores a keyword-only rank 1 (0.3/61) below the semantic rank 8 (0.7/68), so the identifier arm alone would have found rows nobody saw. Shipped: `forge_identifier_words` (IMMUTABLE, migration `0207`), the generated `ident_search` column on the four tables (named `ident_search`, not `text_search_ident`), the OR arm on the memory, knowledge and issue keyword matches, and `HYBRID_ALPHA` 0.5 in memory and knowledge search. The issue search keeps its substring on `description` until the issue FTS work (unmerged) lands. Re-fusing the trial's saved arm lists at 0.5 / 0.5 put 93–100% of identifier truths in the top 8 on all six projects with no change on the natural-language sets.

Gate: phase 0's breakdown over two weeks on `forge-dev` shows `keywordHits` contributing hits that
`semanticHits` missed in more than a small fraction of hybrid calls (the number is chosen when the
table exists, not now), **and** the `forge issues --search` / `forge_memory_search` logs show
identifier-shaped queries (`LITELLM_API_URL`, `runs-cascade.ts`, `ISS-807`) among them.

If so: a second generated column `text_search_ident` on `memories`, `memory_chunks`, `issues` and
`knowledge_entries`, `to_tsvector('simple', <text with camelCase, `_`, `/`, `-` and `.` split to
spaces>)`. The split is an `IMMUTABLE` SQL function so it is legal in a generated column. The
keyword strategy becomes `text_search @@ q(english) OR text_search_ident @@ q(simple)`, ranked by
the sum. `issues/query-filters.ts:buildIssueTextMatch` gets the same OR arm, which is what would let
the issue search drop its substring fallback on `description`.

If not, this phase is deleted from the proposal, not carried.

## Order and size

| Phase | Depends on | New files | Migration | Size |
|---|---|---|---|---|
| 0 analytics breakdown + flag surface (ISS-904) | — | 0 | `app_config.retrieval_rerank`, `memory_model`, `retrieval_expand_relations`, `memory_reindex` | small |
| 1 rerank (luna, listwise) (ISS-905, with phase 3) | 0 | `memory/rerank.ts` | none | medium |
| 2 chunked model (ISS-906) | 0 | `memory/chunker.ts`, `memory/chunk-reindex.ts` | `memory_chunks`, `memories.chunk_generation`, `memories.chunked_at` | large |
| 3 relation expansion (ISS-905, with phase 1) | 0 | 0 | none | small |
| 4 identifier tsvector (ISS-907, shipped 2026-09-05) | 0's evidence | `db/schema-types.ts` | `forge_identifier_words` + 4 generated columns (`0207`) | medium |

Phase 0 owns the only flag migration and is the single `blocks` edge every other phase carries.
Phases 1, 2 and 3 are otherwise independent and may ship in any order; 1 and 3 are the cheap ones.

Filed 2026-09-04 as `draft` on forge-dev: ISS-904 (phase 0), ISS-905 (phases 1+3), ISS-906
(phase 2), ISS-907 (phase 4), the last three each carrying a `blocks` edge on ISS-904. The phase's
tests are its acceptance. Phase 2's backend shipped in ISS-906 on 2026-09-04 and its Memory tab in
ISS-908 on 2026-09-05. The proposal is retired to `docs/modules/knowledge-memory-skills/` once
phase 4 is either opened or declined on the phase-0 evidence — the module README already carries the
shipped rules, so what remains here is the pilot's exit criteria and phase 4's condition.

## Honest costs

| Choice | What it takes |
|---|---|
| A one-in-five holdout while the flag is in pilot | a fifth of eligible agent searches on a pilot project get the unreranked order on purpose, so the comparison has a control. Removed at graduation |
| A reranker at all, and an LLM as the reranker | one chat completion per hybrid search — measured against luna on 2026-09-04 a 24-token answer took one round trip, so expect one to three seconds, not the ~200 ms of a cross-encoder — billed at fast-model rates with up to 50 × 600 characters of prompt. Plus one more thing that can be down: when it is, results silently fall back to RRF order and only the analytics row says so |
| An order instead of a score | an LLM emits a ranking, not a calibrated relevance, so `score` stays the RRF value and a reranked list is not monotonic in `score`. Callers sort by position, not by score; the response says `reranked:true` so they know which they hold |
| A sibling `memory_chunks` table instead of re-keying `memories` | two copies of every chunked document's text on disk and two vectors per memory at minimum. The price of leaving `get`, `decay`, `feedback` and the natural key untouched — that is the trade, and it is taken on purpose |
| Chunking on write | 2–6 embedding calls per memory instead of 1, batched but paid; the near-duplicate probe still compares whole-document vectors, so chunking does not sharpen dedup |
| Migrating a project's existing memories | one embedding bill proportional to that project's text, paid up front on the flip, and a background job that runs for minutes to hours on a large project. Sized with a `SELECT` before the flip, never estimated |
| The generation join on every chunk read | one extra join to `memories` per chunked-mode query, paid so that a failed re-embed can never serve a chunk the parent no longer says |
| The flip as an operation with its own endpoints and page states | five UI states and four endpoints where a boolean would have done, and a status jsonb on `app_config`. The alternative — a flag that quietly runs an hours-long paid job — is what the review refused |
| Reads safe mid-migration via UNION | every chunked-mode query is two arms until the reindex finishes; the planner sees a UNION over two indexed tables, which is fine at this scale and unmeasured beyond it |
| Per-project flags on `app_config` | three more columns on a row that is upserted whole by `PUT /api/app-config/:projectId`; a client that PUTs a stale copy resets them. That is already true of `retrievalTopK` and is the existing contract of that endpoint |
| Relation expansion | up to `topK` extra rows per search that the ranking did not choose, marked `via`, and a `loadIssueRelations` call per top-5 issue hit |
| Phase 4's `IMMUTABLE` split function | a function the schema depends on; changing it requires a table rewrite of four generated columns |
| Not porting the LLM intent gate | a chat turn that would have benefited from a strategy the model did not pick pays the miss. The bet is that the tool description teaches the model well enough, and `retrieval_analytics.requestedStrategy` is where that bet is checked |
| Not porting the graph | any question of the shape "what connects A to B" stays unanswerable from memory. Accepted until someone asks it |
| Follow-ups deliberately left out and unpriced here: an LLM-written chunk prefix (Anthropic contextual retrieval) and an LLM-prompt rerank fallback | each is one more model call per write or per search; they are proposed only after phase 1 and 2 numbers exist |
