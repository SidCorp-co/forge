# Memory & Knowledge

Postgres `pgvector` + FTS memory with a cognitive layer: hybrid retrieval, usage tracking, semantic dedup, decay, fact extraction, and nightly consolidation.

> Sub-doc: [step-handoffs.md](step-handoffs.md) — per-step structured handoff context passed between pipeline stages (own table, not `memories`).
>
> Phases 0–4 of the memory-v2 plan are implemented (proposal deleted on ship, 2026-06-10); phase 5 (graph retrieval strategy, global scope) is future — see Known gaps.

## Overview

- Claude Code has no cross-session memory; Forge adds persistent, project-scoped memory.
- Memory is **pull-based**: agents are instructed (via prompt facts, `prompt/facts/registry.ts`) to call `forge_memory.search` / `forge_memory.write` themselves. Automatic paths: CI-fix-pattern injection into forge-code payloads (read) and post-job fact extraction (write).
- Storage is a single `memories` table in the same Postgres instance as everything else (pgvector HNSW + generated `tsvector`/GIN). No separate vector DB.
- The table is **curated, not append-only**: search hits bump usage counters, near-duplicate writes merge, stale rows decay to `archived_at`, and a nightly LLM pass consolidates.

## Data Flow (current implementation)

```
  Writers:
    issue create/update ──── lifecycle hooks ──┐  (best-effort, detached; issue delete removes the row)
    PM decisions / escalations ────────────────┤  (detached, logged on failure)
    PM policy create/update ───────────────────┤  (best-effort; delete cleans up row)
    CI fix patterns (reopen→developed) ────────┤  (source:'note', kind:'ci_fix_pattern')
    fact extraction (review/test/fix done) ────┤  (≤3 facts as source:'knowledge' + ≤3 knowledge_edges)
    forge_memory.write (MCP) / POST /api/memory┘  (strict; note/knowledge get semantic dedup)
          │
          ▼
  embed (LiteLLM-compatible; embed-input truncated at 8192, FULL text stored)
   — embeddings down? row stored with NULL vector (degraded:true), still
     keyword-searchable; memory-embedding-backfill (*/5) re-embeds later
          │
          ▼
  UPSERT into memories on (project_id, source, source_ref)
   — semantic dedup (note/knowledge, cosine > 0.85): a near-identical row
     absorbs the write instead (result carries dedupedInto)

  Readers:
    forge_memory.search / POST /api/memory/search   strategy: semantic (default) | keyword (FTS) | hybrid (RRF)
    forge_memory.get (MCP) / GET /api/memory        natural-key + JSONB metadata filter (no usage bump)
    ci-fix-pattern-query                            auto-injected into forge-code payloads

  Feedback (recall write-back, ISS-603):
    forge_memory.feedback / POST /api/memory/feedback   confirmed → stamp last_verified_at · outdated → archive now (evidence required); note/knowledge only

  Background jobs (pg-boss):
    memory-embedding-backfill  */5        re-embed degraded rows
    memory-consolidation       03:00      LLM CREATE/UPDATE/ARCHIVE (caps 5/5/10) from 24h signal
    memory-decay               03:30      archive unused note/knowledge; purge 90d-old archives
```

Comments are **deliberately not auto-indexed**: in a pipeline-driven project most comments are bot status chatter, and no automatic read path consumes `source:'comment'`. Agents that want a comment-worth lesson remembered write it explicitly as `source:'knowledge'` (see `memory/indexer.ts`). Job outputs are likewise not auto-indexed; agents persist what matters via step handoffs or explicit writes.

## `memories` table

| Column | Notes |
|--------|-------|
| `id` | uuid PK |
| `project_id` | FK → projects, cascade delete; every query filters on it |
| `source` | enum: `issue` \| `comment` \| `job` \| `note` \| `knowledge` \| `decision` \| `policy` (`comment`/`job` are currently write-dead, kept for compat) |
| `source_ref` | natural key paired with (project, source); max 512 chars |
| `text_content` | FULL text (≤100k); only the embed input is truncated to 8192 chars (`truncated: true` reported) |
| `embedding` | `vector(1536)`, **nullable** — NULL means a degraded write awaiting backfill; semantic search filters `IS NOT NULL`. Dimension hardcoded as `MEMORY_EMBEDDING_DIM`; boot asserts it equals `EMBEDDINGS_DIM` |
| `text_search` | `tsvector` GENERATED ALWAYS from `text_content`, GIN-indexed — keyword strategy |
| `metadata` | jsonb, queried via `@>` containment |
| `retrieval_count` / `last_retrieved_at` | usage tracking — bumped on search hits and ci-fix injections, not natural-key gets |
| `last_verified_at` | recall feedback (ISS-603): agent confirmed the row against live code; decay counts it as activity |
| `archived_at` | soft delete (decay/consolidation); archived rows invisible to all reads; a fresh write to the key revives |
| `embedded_at` / `created_at` / `updated_at` | timestamps (`embedded_at` meaningful only when `embedding` is set) |

Indexes: unique `(project_id, source, source_ref)` (upsert target — exact-key dedup), `(project_id, source)`, `(project_id, source_ref)`, HNSW on `embedding` (`vector_cosine_ops`), GIN on `text_search`.

## Module layout (`packages/core/src/memory/`)

| File | Role |
|------|------|
| `indexer.ts` | `indexMemory` (strict; degraded writes on embeddings outage; opt-in semantic dedup at cosine > 0.85) / `indexMemoryBestEffort` / `deleteMemory`; hook subscriptions for issue create/update |
| `write-service.ts`, `get-service.ts`, `search-service.ts` | shared service layer — REST routes and MCP tools wrap the **same** functions so validation and response shapes are identical. Services do NOT check authorization; callers must. |
| `search.ts` | strategies: semantic (cosine, `score = 1 - distance`), keyword (`websearch_to_tsquery` + `ts_rank`), hybrid (weighted RRF, k=60, α=0.7); `touchMemories` usage bump; topK ≤ 50 |
| `embedding-backfill.ts` | pg-boss `*/5` job re-embedding rows with NULL vectors (degraded writes) |
| `decay.ts` | daily 03:30 job: archive unused `note`/`knowledge` (0 retrievals > 30d, <3 retrievals > 90d; `last_verified_at` counts as activity), purge archives older than 90d |
| `feedback-service.ts` | recall write-back (ISS-603): `confirmed` stamps `last_verified_at`; `outdated` archives immediately + appends evidence to `metadata.feedback` (cap 10); already-archived rows noop |
| `extraction.ts` | post-job (review/test/fix) LLM fact extraction → `source:'knowledge'` + `knowledge_edges`; gated, detached, off without `LITELLM_API_URL` |
| `consolidation.ts` | nightly 03:00 LLM consolidation (CREATE/UPDATE/ARCHIVE, caps 5/5/10) from 24h pipeline signal; archive-only, id-validated, audit `decision` row |
| `llm.ts` | shared non-streaming `LITELLM_*` completion for the background intelligence |
| `write-routes.ts`, `list-routes.ts`, `search-routes.ts` | Hono REST routes; auth = `requireAuth` + email verified + per-user rate limit + `assertProjectMemberAccess` |
| `step-handoff-schema.ts` | structured handoff payloads (separate `step_handoffs` table — see sub-doc) |

MCP tools (`mcp/tools/forge-memory.ts`): `forge_memory.search` / `.get` / `.write` / `.delete` / `.feedback`, device-scoped via `assertDeviceOwnerIsMember` (writes/feedback: `assertDeviceOwnerIsWriter`).

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/memory/search` | `{projectId, query, topK≤50, sourceFilter?, strategy?}` → `{hits, model, took_ms, strategy, degraded?}`. `strategy`: `semantic` (default, cosine-similarity scores) \| `keyword` (FTS, no embed call) \| `hybrid` (RRF — fused-rank scores, NOT similarity; degrades to keyword on embeddings outage). Semantic-only 503s when embeddings are down. Logged to `retrieval_analytics`. |
| `POST` | `/api/memory` | Upsert a memory row → `{id, embeddedAt, truncated, degraded, dedupedInto?}` (201) |
| `GET` | `/api/memory` | List by project (+ optional source), paginated; excludes archived |
| `DELETE` | `/api/memory/by-source` | Delete by natural key → `{deleted: n}` |
| `DELETE` | `/api/memory/:id` | Idempotent; always 204 for unauthorized callers (no id-existence leak) |

Write 30/min and search 60/min per user (`RATE_LIMIT_MEMORY_*` env overrides) — both endpoints spend embedding tokens.

## Invariants

- **Natural-key upsert**: re-writing the same `(projectId, source, sourceRef)` refines the row; re-writing an archived key revives it. Semantic dedup (note/knowledge, cosine > 0.85) additionally absorbs would-be-new near-duplicates into the existing row (`dedupedInto`).
- **Strict vs best-effort**: explicit callers (REST, MCP, knowledge ingest) get errors; hook subscribers swallow them (eventually consistent — a later edit re-indexes). Embeddings OUTAGES never error a write: the row lands without a vector (`degraded: true`) and the backfill re-embeds it.
- **Truncation**: only the embed input is cut at 8192 chars; the stored `text_content` is always full. Callers see `truncated: true`.
- **Auth at the edges**: every REST/MCP surface asserts project membership before touching services.
- **Score semantics**: only `strategy:'semantic'` returns cosine similarity — thresholds (e.g. the knowledge-dedup fact's `> 0.8`) must not be applied to keyword/hybrid scores.
- **LLM curation never hard-deletes**: extraction/consolidation can create, merge, and archive; purging is the decay job's 90-day-grace responsibility alone.

## Learning loops (current)

| Loop | Mechanism |
|------|-----------|
| CI fix patterns (`pipeline/ci-fix-pattern-learn.ts`) | On `reopen → developed`, capture (errorTypes, fileTypes, diffSummary) as `source:'note'`, `kind:'ci_fix_pattern'`; capped at 5 per error type; query side injects matches into forge-code payloads and counts them as retrievals |
| Fact extraction (`memory/extraction.ts`) | review/test/fix `jobCompleted` → heuristic gate over recent issue comments (correction language incl. Vietnamese always passes) → fast-model prompt → ≤3 `source:'knowledge'` facts (dedup ON) + ≤3 `knowledge_edges` with `issue:<id>` provenance |
| Consolidation (`memory/consolidation.ts`) | Nightly per-project: 24h signal (comments, status changes, **reopen cycles**) → LLM CREATE/UPDATE/ARCHIVE with caps, hallucinated-id guard, audit `decision` row |
| Decay (`memory/decay.ts`) | Usage-driven forgetting for `note`/`knowledge` only; lifecycle mirrors (issue/decision/policy) are exempt |
| Knowledge convention notes | Prompt facts instruct agents: search first (`sourceFilter:['knowledge']`, semantic score > 0.8), else write with a stable kebab `sourceRef` |
| Knowledge edges (`knowledge-edges/`) | `knowledge_edges` table: subject/predicate/object triples with `confidence`, `sourceMemoryId`, temporal validity; written by extraction, CRUD via REST — not yet a retrieval strategy (phase 5) |

## Memory candidates (continuous learning, ISS-534/554)

A confidence-accrual staging area **upstream** of both `memories` and `improvement_message_drafts`: repeated pipeline signals (and now agent self-reports, see the feedback bridge below) accrue into a candidate before a human accepts, rejects, or promotes it. Signals never write straight to `memories` — they build evidence first.

- **Table** `memory_candidates` (`db/schema.ts:1652`): `signal_type`, `signal_key`, `status` — `memoryCandidateStatuses`: `accruing` → `graduated` → `accepted` \| `rejected` \| `promoted` (terminal), `confidence` (default 0.30), `evidence_count`, `evidence` (jsonb), `summary`; unique `(project_id, signal_type, signal_key)`.
- **Files** (`packages/core/src/memory/`): `candidates-observer.ts` (subscribes to pipeline signals), `candidates-accrual.ts` (read-modify-write confidence accrual / evidence merge), `candidates-decay.ts` (ages out stale candidates), `candidates-service.ts` (list graduated / accept / reject / mark-promoted), `candidates-routes.ts` (REST).
- **Endpoints** (mounted `/api/memory`, auth = project `viewer`): `GET /api/memory/candidates` (graduated only, paginated) · `POST /api/memory/candidates/:id/accept` · `POST /api/memory/candidates/:id/reject` (archives) · `POST /api/memory/candidates/:id/promote` (graduated-only, 409 otherwise — creates an `improvement_message_drafts` row, see the feedback bridge below, then flips status to `promoted`).

## `knowledge_entries` — curated knowledge (separate from `memories`)

**`knowledge_entries` is a distinct table from `memories`, not another name for
`source:'knowledge'` rows.** Both are semantically searchable per-project text, but:

| | `memories` (`source:'knowledge'`) | `knowledge_entries` |
|---|---|---|
| Written by | agents, mostly autonomously (extraction/consolidation) | curators — `authoredBy`: `human` \| `agent` (default) \| `imported` |
| Lifecycle | decays, archives, semantic-dedups | persists until explicitly deleted; no decay job |
| Shape | free-text fact + `metadata` | structured: `kind`, `title`, `body`, `injection`, `confidence`, `tags` |
| Read path | pull (`forge_memory.search`) | pull (`forge_knowledge`) **or** always-inject into the system prompt (`injection:'always'`) |

`schema.ts:1720`. `kind` enum `knowledgeKinds`: `overview` \| `scenario` \| `workflow` \| `rule`
\| `guide` \| `reference` \| `glossary`. `injection` enum: `always` \| `on_demand` \| `none`.
`confidence` enum: `verified` \| `inferred` \| `deprecated`. Unique on `(projectId, slug)`;
same pgvector/FTS shape as `memories` (own HNSW + GIN indexes).

### Injection tiers

`prompt/facts/resolve.ts:261` gates the source of always-inject facts on
**`KNOWLEDGE_INJECTION_ENABLED`** (`config/env.ts:142`, **defaults `false`**):

- **OFF** (default) — always-inject facts and `{{project:key}}` keys come from
  `agentConfig.projectFacts` / `projectFactsConfig`, as today.
- **ON** — `selectAlwaysInjectFromKnowledge` / `selectOnDemandSlugsFromKnowledge` source the
  same two things from `knowledge_entries` (`injection:'always'` rows; `on_demand` slugs)
  instead. The `{{project:key}}` template resolver still reads `agentConfig` regardless, for a
  deprecation window. Any DB error during the ON path falls back to the `agentConfig` read so
  the prompt build never breaks.

### API endpoints

REST, `knowledge/routes.ts` (`/api/projects/:id/...`, member) + `knowledge/ingest-routes.ts`
(`/api/knowledge/ingest`, member, rate-limited 100/min/project — bulk import, always
`kind:'reference'`/`injection:'on_demand'`).

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/api/projects/:id/knowledge` | list, optional `?kind=`/`?injection=` |
| `GET` | `/api/projects/:id/knowledge/:slug` | full entry |
| `PUT` | `/api/projects/:id/knowledge/:slug` | upsert |
| `DELETE` | `/api/projects/:id/knowledge/:slug` | idempotent |
| `POST` | `/api/knowledge/ingest` | bulk (≤20 docs/request, ≤50KB each) |

MCP tool `forge_knowledge` (`mcp/tools/forge-knowledge.ts`) mirrors the same service functions:
`list` / `get` / `upsert` / `delete` (member/writer) plus `search` — `scope: 'knowledge'`
(default) \| `'memory'` \| `'all'` (both stores, each hit labeled `origin`), same
semantic/keyword/hybrid strategies as `forge_memory.search`.

## Feedback → candidate → improvement-message bridge

A second signal path into `memory_candidates`, alongside the pipeline-signal observer already
described above: agents can self-report friction directly, and a human-curated report can
graduate into a shareable improvement message.

```
  forge_feedback (MCP, agent self-report)
        │  kind/severity/target/summary; server stamps signalKey = self_report:<target>:<targetRef|'-'>:<kind>
        ▼
  feedback_reports  (schema.ts:3043)
        │  jobCompleted/jobFailed hook (feedback/normalizer.ts, registerFeedbackNormalizer)
        ▼
  upsertCandidate(signalType:'agent_self_report', signalKey, evidence)  ──▶  memory_candidates
        │  (report.candidateId back-set after upsert)
        │  human reviews graduated candidates, POSTs .../promote
        ▼
  improvement_message_drafts  (schema.ts:3126)
        │  key = draft-<slug(signalKey)>; status: pending_review → published/dismissed
        │  human curator promotes into the static improvement-message registry (out of band)
```

- **`feedback_reports`** — one row per agent self-report. `kind` enum `feedbackKinds`:
  `friction` \| `bug` \| `skill_gap` \| `unclear_step` \| `redundant_step` \| `learning` \|
  `suggestion`. `target` enum `feedbackTargets`: `skill` \| `prompt` \| `tool` \| `doc` \|
  `orientation` \| `pipeline` \| `other`. `issueId` is the SOURCE issue (where the agent was
  working); `linkedIssueId` (ISS-712) is set only via the review action and is the issue the
  report was curated INTO — a different issue, resolved against every project the reviewing
  user can see (not just the report's own project).
- **`improvement_message_drafts`** — one row per promoted candidate. `status` enum
  `improvementMessageDraftStatuses`: `pending_review` \| `published` \| `dismissed`. `message`
  is wrapped `⟦UNTRUSTED_DATA⟧` (agent-authored). `candidateId` traces back to the seeding
  `memory_candidates` row.

Read endpoints:

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/api/feedback-reports` | list, project member; filters kind/severity/target/reviewed, `scope:'all'` rolls up every visible project |
| `GET` | `/api/memory/candidates` | graduated candidates for a project (see Memory candidates above) |
| `GET` | `/api/improvement-messages` | static catalog + per-project schedule enablement |
| `GET` | `/api/improvement-messages/drafts` | `pending_review` drafts for a project |

`POST /api/feedback-reports/:id/reviewed` marks a report reviewed and optionally links it.
`POST /api/memory/candidates/:id/promote` requires `status:'graduated'`, creates the draft, then
flips the candidate to `status:'promoted'` — it seeds an `improvement_message_drafts` row, not
a new `memories` row.

## Known gaps (phase 5, future)

Graph retrieval strategy over `knowledge_edges` (+ pagerank), `auto` strategy via intent classification, org-scoped memories (needs an authz story), MEMORY.md export for runner devices, cross-encoder reranking, contextual chunk prefixes for knowledge ingest. The 0.85 dedup threshold is inherited from forge-agents and should be re-validated against the configured embedding model.

`ux-contract-recompile.ts` (see [ux-contract](../ux-contract/README.md#known-gaps)) does not
write through `knowledge_entries` when `KNOWLEDGE_INJECTION_ENABLED` is on — it only ever
writes `agentConfig.projectFacts`, so flipping the flag on a project using UX Contract would
silently drop that project's compiled contract from agent prompts.

## Cross-Module Touchpoints

| Direction | Module | What |
|-----------|--------|------|
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Issue title/description on create/update (hooks) |
| Receives from | [agents-jobs](../agents-jobs/README.md) | `jobCompleted` (review/test/fix) triggers fact extraction |
| Receives from | PM module | Decisions, escalations, policies |
| Read by | [agents-jobs](../agents-jobs/README.md) | Pull-based via `forge_memory` MCP; CI-fix patterns pushed into forge-code payloads |
| Adjacent | knowledge-edges, skill-facts, step-handoffs | Separate tables, separate surfaces |
