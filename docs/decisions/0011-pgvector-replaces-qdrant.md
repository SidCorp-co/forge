# ADR 0011 — Postgres `pgvector` replaces Qdrant for vector storage

- **Status:** Implemented
- **Date:** 2026-04-23
- **Implemented:** 2026-04-24
- **Promotes:** D4 in [proposals/core-strapi-decoupling.md](../proposals/core-strapi-decoupling.md)
- **Supersedes:** vector-DB statements in [ADR 0002](0002-replace-strapi-with-hono-drizzle.md), [ADR 0006](0006-pg-boss-for-job-queue.md), and [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md) §Stack ("Qdrant — unchanged")

## Context

The legacy Strapi build runs Qdrant 1.13 as a separate service for embeddings. With `forge/core` rebuilt from scratch ([ADR 0010](0010-clean-break-from-strapi.md)), and the embedding workload being modest (issues + comments + job outputs + project knowledge — tens of thousands of vectors per project, not millions), the case for a dedicated vector service weakened:

- Operational surface: every self-hoster runs an extra container, extra port, extra healthcheck, extra backup target.
- No transactional join: the vector store is separate from the relational store, so writing an issue + its embedding requires two-phase logic and reconciliation.
- Memory baseline: Qdrant adds ~150 MB RAM idle, conflicting with the "small self-host" narrative restated in RFC 0002.
- Postgres has had production-grade vector support via `pgvector` for several releases, with HNSW indexing since 0.5.0.

## Decision

Vector storage moves into the **same Postgres instance** that holds relational data + pg-boss jobs, via the `pgvector` extension.

- One `memories` table with a `vector vector(N)` column (N = embedding dimension, default 1536).
- Index type: **HNSW** (`USING hnsw (vector vector_cosine_ops)`).
- Same Drizzle connection — no second client, no second pool.
- `CREATE EXTENSION IF NOT EXISTS vector;` is the first migration in `forge/core/migrations/`.
- The `qdrant` service is removed from `docker-compose.yml` at the Phase 2.5 flip PR.

This makes Postgres the **single data store** for `forge/core`: rows, jobs, vectors.

## Rationale

- **One data store = one backup, one migration story, one connection pool.**
- **Transactional consistency** — issue insert + embedding insert in one statement (or one transaction). No reconciliation jobs.
- **Memory and disk savings** — no Qdrant container; ~150 MB RAM and ~200 MB disk back.
- **HNSW recall is sufficient at our scale** — we do not have a million-vector workload that would push us toward a specialized vector DB.
- **Drizzle has first-class `vector` column support** — no ORM workarounds.
- **Aligns with the OSS narrative** — "runs on Postgres" is one sentence; "runs on Postgres + Qdrant + pg-boss" requires explanation.

### Index type — why HNSW, not IVFFlat

| | IVFFlat | HNSW |
|---|---|---|
| Build speed | Faster | Slower |
| Query recall | Lower (approximate) | Higher |
| Re-index on data growth | Required | Less sensitive |
| Best for | Static, very large corpora | Small-to-medium, recall-sensitive |

Agent context retrieval is recall-sensitive (a missed memory is worse than a slower query at our scale), and the corpus is small. HNSW wins on both axes that matter for v0.x.

## Alternatives considered

1. **Keep Qdrant.** Rejected — operational cost dominates the benefit at our scale; we'd be paying for capability we don't use.
2. **Move to `sqlite-vss` for self-host simplicity.** Rejected — Postgres is already mandatory; adding SQLite as a parallel datastore is the wrong direction. `pgvector` collapses everything onto one engine.
3. **External vector services (Pinecone, Weaviate Cloud).** Rejected — requires network calls for every memory write/read, hard dependency on a SaaS, breaks self-host.
4. **`ivfflat` index instead of HNSW.** Rejected per recall analysis above. Re-evaluate if the corpus crosses ~1M vectors per project.

## Consequences

### Positive

- `docker-compose.yml` drops one service (`qdrant`).
- Single connection pool, single backup target, single restore drill.
- Embedding writes can join issue/job writes in one transaction — eliminates the "embedded but no source row" / "source row but no embedding" reconciliation failure modes.
- Self-host story shortens: "Postgres + `forge/core`" instead of "Postgres + Qdrant + Strapi".

### Negative

- Postgres connection budget now includes vector-search load. Mitigation: HNSW queries are cheap at our scale; we revisit if connection pressure shows up in p95 latencies.
- If the embedding corpus grows ~100× beyond projection, we may revisit a dedicated vector DB. The `memories` table is small enough to extract cleanly via dump-and-load.
- `pgvector` extension must be installed in the Postgres image. Mitigation: docker-compose uses an image with `pgvector` preinstalled (`pgvector/pgvector:pg17`).

## Re-entry / re-evaluation criteria

Switch back to a dedicated vector DB only if **all** are true:

- `memories` table exceeds ~5M rows in a single deployment, **and**
- p95 vector-search latency exceeds 200 ms with HNSW tuned (`m`, `ef_construction`), **and**
- Postgres connection pool shows contention attributable to vector queries.

Until then, `pgvector` is the answer.

## Implementation notes

- `CREATE EXTENSION IF NOT EXISTS vector;` shipped as the first migration in `forge/core/migrations/`.
- `memories` table uses `vector(1536)` column with HNSW index on `vector_cosine_ops` as specified.
- `qdrant` service removed from `docker-compose.yml` and `docker-compose.prod.yml` in the ISS-219 flip.
- Postgres image pinned to `pgvector/pgvector:pg17` in `docker-compose.yml`, `docker-compose.prod.yml`, and the CI e2e-web service.
- Drizzle first-class `vector` column support used throughout `forge/core/src/db/schema/`.

## Related

- Driven by: [ADR 0010](0010-clean-break-from-strapi.md) (clean-break gives us the freedom to redo storage choices)
- Affected docs: [docs/modules/memory-knowledge/README.md](../modules/memory-knowledge/README.md), [docs/architecture/system-overview.md](../architecture/system-overview.md), [docs/quickstart.md](../quickstart.md)
- Supersedes vector-DB language in: [ADR 0002](0002-replace-strapi-with-hono-drizzle.md), [ADR 0006](0006-pg-boss-for-job-queue.md), [RFC 0002](../rfcs/0002-replace-strapi-with-hono-drizzle.md) §Stack
