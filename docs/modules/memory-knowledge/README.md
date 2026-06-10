# Memory & Knowledge

Postgres `pgvector` semantic memory, project knowledge edges, and pipeline learning loops.

> Sub-doc: [step-handoffs.md](step-handoffs.md) — per-step structured handoff context passed between pipeline stages (own table, not `memories`).
>
> Roadmap: [../../proposals/memory-v2-cognitive-layer.md](../../proposals/memory-v2-cognitive-layer.md) — plan to port the cognitive memory features (hybrid retrieval, usage tracking, dedup, decay, extraction, consolidation) from the `forge-agents` predecessor.

## Overview

- Claude Code has no cross-session memory; Forge adds persistent, project-scoped memory.
- Memory is **pull-based**: agents are instructed (via prompt facts, `prompt/facts/registry.ts`) to call `forge_memory.search` / `forge_memory.write` themselves. The only automatic injection is CI-fix-pattern context added to forge-code job payloads.
- Storage is a single `memories` table in the same Postgres instance as everything else (pgvector extension, HNSW cosine index). No separate vector DB.

## Data Flow (current implementation)

```
  Writers:
    issue create/update ──── lifecycle hooks ──┐  (best-effort, detached)
    PM decisions / escalations ────────────────┤  (detached, logged on failure)
    PM policy create/update ───────────────────┤  (best-effort; delete cleans up row)
    CI fix patterns (reopen→developed) ────────┤  (source:'note', kind:'ci_fix_pattern')
    knowledge ingest (.forge/knowledge.json) ──┤  (strict — errors reported)
    forge_memory.write (MCP) / POST /api/memory┘  (strict — errors reported)
          │
          ▼
  embed (LiteLLM-compatible service, truncate at 8192 chars)
          │
          ▼
  UPSERT into memories on (project_id, source, source_ref)

  Readers:
    forge_memory.search (MCP) / POST /api/memory/search   semantic top-K, agent-initiated
    forge_memory.get (MCP) / GET /api/memory               natural-key + JSONB metadata filter
    ci-fix-pattern-query                                   auto-injected into forge-code payloads
```

Comments are **deliberately not auto-indexed**: in a pipeline-driven project most comments are bot status chatter, and no automatic read path consumes `source:'comment'`. Agents that want a comment-worth lesson remembered write it explicitly as `source:'knowledge'` (see `memory/indexer.ts`). Job outputs are likewise not auto-indexed; agents persist what matters via step handoffs or explicit writes.

## `memories` table

| Column | Notes |
|--------|-------|
| `id` | uuid PK |
| `project_id` | FK → projects, cascade delete; every query filters on it |
| `source` | enum: `issue` \| `comment` \| `job` \| `note` \| `knowledge` \| `decision` \| `policy` (`comment`/`job` are currently write-dead, kept for compat) |
| `source_ref` | natural key paired with (project, source); max 512 chars |
| `text_content` | the embedded text (truncated to 8192 chars before embed **and** store) |
| `embedding` | `vector(1536)` — dimension hardcoded as `MEMORY_EMBEDDING_DIM`; must match `EMBEDDINGS_DIM` env |
| `metadata` | jsonb, queried via `@>` containment |
| `embedded_at` / `created_at` / `updated_at` | timestamps |

Indexes: unique `(project_id, source, source_ref)` (upsert target — natural-key dedup), `(project_id, source)`, `(project_id, source_ref)`, HNSW on `embedding` (`vector_cosine_ops`).

## Module layout (`packages/core/src/memory/`)

| File | Role |
|------|------|
| `indexer.ts` | `indexMemory` (strict, throws) / `indexMemoryBestEffort` (logs + swallows) / `deleteMemory`; hook subscriptions for issue create/update |
| `write-service.ts`, `get-service.ts`, `search-service.ts` | shared service layer — REST routes and MCP tools wrap the **same** functions so validation and response shapes are identical. Services do NOT check authorization; callers must. |
| `search.ts` | pgvector cosine query (`score = 1 - distance`), source + metadata filters, topK ≤ 50 |
| `write-routes.ts`, `list-routes.ts`, `search-routes.ts` | Hono REST routes; auth = `requireAuth` + email verified + `assertProjectMemberAccess` |
| `step-handoff-schema.ts` | structured handoff payloads (separate `step_handoffs` table — see sub-doc) |

MCP tools (`mcp/tools/forge-memory.ts`): `forge_memory.search` / `.get` / `.write` / `.delete`, device-scoped via `assertDeviceOwnerIsMember`.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/memory/search` | Semantic query: `{projectId, query, topK≤50, sourceFilter?}` → `{hits, model, took_ms}`; 503 on embeddings outage |
| `POST` | `/api/memory` | Upsert a memory row → `{id, embeddedAt, truncated}` (201) |
| `GET` | `/api/memory` | List by project (+ optional source), paginated |
| `DELETE` | `/api/memory/by-source` | Delete by natural key → `{deleted: n}` |
| `DELETE` | `/api/memory/:id` | Idempotent; always 204 for unauthorized callers (no id-existence leak) |

## Invariants

- **Natural-key upsert**: re-writing the same `(projectId, source, sourceRef)` refines the row instead of duplicating — this is the only dedup mechanism (exact-key, not semantic).
- **Strict vs best-effort**: explicit callers (REST, MCP, knowledge ingest) get errors; hook subscribers swallow them (eventually consistent — a later edit re-indexes). Detached work uses `queueMicrotask`; durability upgrade path is pg-boss (queue already running).
- **Truncation**: text > 8192 chars is cut before embedding *and* before storing; callers see `truncated: true`.
- **Auth at the edges**: every REST/MCP surface asserts project membership before touching services.

## Learning loops (current)

| Loop | Mechanism |
|------|-----------|
| CI fix patterns (`pipeline/ci-fix-pattern-learn.ts`) | On `reopen → developed`, capture (errorTypes, fileTypes, diffSummary) as `source:'note'`, `kind:'ci_fix_pattern'`; capped at 5 per error type; query side injects matches into forge-code payloads |
| Knowledge convention notes | Prompt facts instruct agents: search first (`sourceFilter:['knowledge']`, score > 0.8), else write with a stable kebab `sourceRef` |
| Knowledge edges (`knowledge-edges/`) | `knowledge_edges` table: subject/predicate/object triples with `confidence`, `sourceMemoryId`, temporal validity (`validFrom`/`validUntil`); CRUD-only today — not yet used as a retrieval strategy |

## Known gaps

Tracked in the [memory-v2 proposal](../../proposals/memory-v2-cognitive-layer.md): no hybrid/keyword retrieval (semantic-only), no usage tracking or decay, no semantic dedup, no extraction from sessions, no consolidation job, deleted issues leave their memory rows behind, writes hard-fail when embeddings are down (no degraded path).

## Cross-Module Touchpoints

| Direction | Module | What |
|-----------|--------|------|
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Issue title/description on create/update (hooks) |
| Receives from | PM module | Decisions, escalations, policies |
| Read by | [agents-jobs](../agents-jobs/README.md) | Pull-based via `forge_memory` MCP; CI-fix patterns pushed into forge-code payloads |
| Adjacent | knowledge-edges, skill-facts, step-handoffs | Separate tables, separate surfaces |
