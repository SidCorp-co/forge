# Memory & Knowledge

Postgres `pgvector` semantic memory, project knowledge graph, RAG retrieval.

## Overview

Claude Code has no memory between sessions by default. Forge adds persistent memory: the system captures issue content, agent session outputs, decisions, and resolved errors; embeds them and stores the vectors in Postgres via `pgvector` (same connection as the rest of the data); and surfaces relevant context to agents at the start of each session.

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

- Single table for all projects, partitioned by `project_id` filter on every query (project scope enforced in the policy layer)
- `vector vector(N)` column — N matches the embedding model dimension (default 1536)
- Index: HNSW on `vector` (`USING hnsw (vector vector_cosine_ops)`) per [ADR 0011](../../decisions/0011-pgvector-replaces-qdrant.md)
- Indexed columns: `(project_id, source)`, `(project_id, source_ref)`
- Payload columns: `source`, `source_ref`, `project_id`, `metadata jsonb`, `embedded_at`

## Key Business Flows

### Indexing on issue create

1. User creates issue → `issue:created` hook fires
2. Embeddings service normalizes text (strip markdown, canonicalize whitespace)
3. POST to embedding provider (LiteLLM)
4. INSERT/UPDATE into `memories` (vector + metadata) in one statement
5. `embeddedAt` set; broadcast `memory:indexed` over ws to subscribed clients

### Retrieval at session start

1. Agent session starts on device
2. System prompt builder calls `forge_memory.search(query, projectId)` via MCP
3. Server runs `SELECT ... FROM memories WHERE project_id = $1 ORDER BY vector <=> $2 LIMIT K` (cosine distance via HNSW index)
4. Top-K results returned, sorted by relevance
5. Returned as context snippets in system prompt
6. Session runs with context

### Project knowledge indexing (manual trigger)

1. User clicks "Reindex codebase" on project settings
2. Device runs `index-codebase` skill: scans filesystem, runs `grep` + semantic search
3. Generates `.forge/knowledge.json` with: architecture notes, key files, conventions
4. Uploads to server
5. Server embeds and stores as `source: 'knowledge'` memory

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `GET` | `/api/projects/:id/memory/search?q=` | user / device | Query memory semantically |
| `POST` | `/api/projects/:id/memory` | user | Add manual memory note |
| `DELETE` | `/api/memory/:id` | user | Remove a memory entry |
| `POST` | `/api/projects/:id/memory/reindex` | user | Trigger full reindex |

MCP tool:
- `forge_memory` — exposes the same search to agents

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
