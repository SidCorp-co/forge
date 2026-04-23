# ADR 0006 — pg-boss for job queue (no Redis dependency)

- **Status:** Accepted
- **Date:** 2026-04-19

> **Reader note (2026-04-23):** This ADR's "docker-compose stays at Postgres + Qdrant + Jarvis" line is **superseded by [ADR 0011](0011-pgvector-replaces-qdrant.md)** — Qdrant is removed; vector storage moves into Postgres via `pgvector`. The pg-boss decision itself is unchanged.

## Context

The control plane needs a reliable job queue for:
- Dispatching `forge-*` pipeline skills to devices
- Retrying failed jobs with backoff
- Scheduled jobs (nightly cleanup, stale detection, usage aggregation)
- Event persistence for replay

Standard options for Node-based queues:
- **BullMQ** — requires Redis
- **Bee-Queue** — requires Redis
- **Agenda** — MongoDB-based
- **pg-boss** — uses the existing Postgres
- **Temporal / Inngest** — durable workflow engines, own infrastructure

## Decision

Use **pg-boss** for job queue and scheduling in v0.x.

## Rationale

- **Zero additional services** — Postgres already runs. No Redis, no MongoDB. docker-compose stays at Postgres + Qdrant + Jarvis.
- **Self-host friendly** — every self-hoster already has Postgres; no "install Redis" step.
- **Good enough for our scale** — pg-boss handles thousands of jobs/day easily. We won't exceed that until Month 12+ at current trajectory.
- **Built-in features** — retries, scheduling, deadlock detection, deletion policies — all that we need.
- **Mature and maintained** — pg-boss has been stable since 2018.

## Alternatives considered

1. **BullMQ + Redis** — rejected: adds a required service for every self-hoster; most OSS projects that use Redis eventually hear "please make Redis optional" as an adoption objection.
2. **In-process queue (no persistence)** — rejected: jobs must survive server restarts; can't lose JobEvents mid-stream.
3. **Temporal** — rejected at this stage: overkill for v0.x, adds a required service, durable-workflow primitives aren't needed yet. Reserve for v1.0+ if we hit real scale.
4. **Inngest** — rejected: SaaS-first; self-host is newer and less battle-tested.
5. **PostgreSQL LISTEN/NOTIFY + SKIP LOCKED** — rejected: we'd be reinventing pg-boss. Use the library.

## Consequences

### Positive
- Self-host simplicity preserved
- No Redis ops burden
- Jobs + data in same database → transactional consistency is easier (if we need it)

### Negative
- pg-boss max throughput (~10k jobs/minute on a decent Postgres) is lower than Redis-backed queues — we'll need to migrate if we ever exceed that
- All job overhead touches Postgres → need to monitor DB load carefully
- Scheduled jobs depend on pg-boss's cron-like mechanism, which is less flexible than standalone cron

## Migration trigger (pre-specified)

If any of these hold true, revisit this ADR:

- Sustained >5k jobs/minute for 4 consecutive weeks
- Postgres CPU consistently >60% under normal load
- Job-dispatch latency p95 > 500ms
- A real use case for durable workflows (multi-step, multi-day) emerges

At that point, consider:
- **Upgrade to BullMQ + Redis** (simpler migration, still Node)
- **Upgrade to Temporal** (durable workflows, steeper migration)

## Related

- Required by: [ADR 0002](0002-replace-strapi-with-hono-drizzle.md) (new service keeps the queue choice)
- Compatible with: [ADR 0001](0001-device-runner-architecture.md) (device-runner dispatches through this queue)
