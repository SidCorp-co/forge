# Memory & Knowledge

Postgres `pgvector` semantic memory, project knowledge graph, RAG retrieval.

> Sub-doc: [step-handoffs.md](step-handoffs.md) — per-step structured handoff context passed between pipeline stages.

## Overview

- Claude Code has no cross-session memory; Forge adds persistent memory.
- Captures issue content, agent session outputs, decisions, resolved errors → embeds → stores vectors in Postgres `pgvector` (same connection as the rest of the data).
- Surfaces relevant context to agents at the start of each session.

## Data Flow

```
  Sources of memory:
    - Issue title + description
    - Comment bodies
    - Job outputs (stdout, tool results)
    - sessionContext (decisions, resolved errors, files modified)
    - User-added memory notes
          │
          ▼ lifecycle hooks
  ┌────────────────────┐
  │ Embed + normalize  │ (via embeddings service)
  └────────┬───────────┘
           │
           ▼
  ┌────────────────────┐
  │ pgvector upsert    │ row in `memories` with metadata cols + vector
  └────────────────────┘

  Retrieval:
  ┌────────────────────┐
  │ Query embedding    │ ← agent session start, or user query
  └────────┬───────────┘
           │
           ▼
  ┌────────────────────┐
  │ Multi-strategy      │
  │ search (semantic +  │ ← project-scoped by default
  │  keyword + graph)   │
  └────────┬───────────┘
           │
           ▼
  Relevant context snippets returned to agent's system prompt
```

### Input Sources

| Data | Source | Indexed when |
|------|--------|--------------|
| Issue description | `issues-pipeline` lifecycle `issue:created` / `issue:updated` | On save |
| Comment body | `comments` lifecycle | On save |
| Job result + sessionContext | `agents-jobs` lifecycle `job:completed` | On terminal |
| User memory note | User explicitly added via UI | On save |
| Project knowledge snapshot | `.forge/knowledge.json` from device | On project sync |

### ID Resolution

| Input | Transform | Stored as |
|-------|-----------|-----------|
| Issue/comment/job text | Embedding (model per project config) | `vector` column in `memories` table |
| Source type | Column | `source: 'issue' \| 'comment' \| 'job' \| 'note' \| 'knowledge'` |
| Project scope | Column | `project_id: <uuid>` (indexed) |

## Core Entities

### `Memory` (DB record — canonical form before embedding)

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `project` | Belongs to one project |
| `source` | `issue` \| `comment` \| `job` \| `note` \| `knowledge` |
| `sourceRef` | Reference to the source record |
| `text` | The content embedded |
| `metadata` | Additional tags (priority, status, tools used, etc.) |
| `embeddedAt` | Timestamp of vector upsert |

### `memories` table layout (Postgres + pgvector)

- Single table for all projects, partitioned by `project_id` filter on every query (project scope enforced in policy layer)
- `vector vector(N)` column — N matches embedding model dimension (default 1536)
- Index: HNSW on `vector` (`USING hnsw (vector vector_cosine_ops)`) per ADR 0011
- Indexed columns: `(project_id, source)`, `(project_id, source_ref)`
- Payload columns: `source`, `source_ref`, `project_id`, `metadata jsonb`, `embedded_at`

## Key Business Flows

- **Indexing on issue create:** `issue:created` hook → embeddings service normalizes text (strip markdown, canonicalize whitespace) → POST to embedding provider (LiteLLM) → INSERT/UPDATE into `memories` (vector + metadata) in one statement → `embeddedAt` set; broadcast `memory:indexed` over ws to subscribed clients.
- **Retrieval at session start:** Agent session starts on device → system prompt builder calls `forge_memory.search(query, projectId)` via MCP → server runs `SELECT ... FROM memories WHERE project_id = $1 ORDER BY vector <=> $2 LIMIT K` (cosine distance via HNSW index) → top-K sorted by relevance returned as context snippets in system prompt → session runs with context.
- **Project knowledge indexing (manual trigger):** User clicks "Reindex codebase" → device runs `index-codebase` skill (scans filesystem, `grep` + semantic search) → generates `.forge/knowledge.json` (architecture notes, key files, conventions) → uploads to server → server embeds and stores as `source: 'knowledge'` memory.

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/memory/search` | user / device | Query memory semantically (JSON body) |
| `POST` | `/api/memory` | user | Add manual memory note |
| `DELETE` | `/api/memory/:id` | user | Remove a memory entry |

MCP tool: `forge_memory` — exposes the same search to agents.

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Issue / comment embeddings | On lifecycle save |
| Receives from | [agents-jobs](../agents-jobs/README.md) | Job result + sessionContext | On job completion |
| Read by | [agents-jobs](../agents-jobs/README.md) | Relevant context via `forge_memory` MCP tool | At session start |
| Read by | [chat](../chat/README.md) | Same retrieval surface for chat conversations | On each turn |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `memory-reindexer` (manual trigger) | Rebuild all embeddings for a project (e.g., after model change) |
| `knowledge-sync` (device → server) | Upload `.forge/knowledge.json` changes |

## Future (v0.2+)

- Knowledge graph edges (explicit entity relations, not just embeddings)
- Semantic search UI (currently agents-only via MCP)
- Memory decay / forgetting policies
- Per-user memory (separate from project memory)
