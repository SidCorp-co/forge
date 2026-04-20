# ADR 0002 — Replace Strapi backbone with Hono + Drizzle service

- **Status:** Proposed — pending RFC 0002 acceptance
- **Date:** 2026-04-20
- **Full design:** RFC 0002 (to be drafted)

## Context

The original backend was built on Strapi 5 for speed of prototyping — schema-first content types gave us admin UI and REST for free. Eight months in, the costs are clear:

- **Upgrade treadmill** — Strapi v4 → v5 required rewriting internals. v5 → v6 will likely do the same. Every major version disrupts contributors.
- **Wrong workload shape** — Strapi is a CMS. Jarvis Agents needs high-throughput WebSocket, event-sourced job dispatch, multi-principal auth, MCP server exposure. All hand-built against Strapi's lifecycle model, which was designed for CRUD publishing.
- **Memory footprint** — ~400MB baseline conflicts with our "simple self-host" narrative.
- **OSS contributor friction** — "Why is this built on Strapi?" will be asked by every incoming engineer. The answer has to be technical, not "we started there."
- **Admin UI is a liability** — Strapi admin exposes full CRUD by default; custom admin surface would be smaller and safer.
- **WebSocket + MCP + job queue + dual-principal auth are all custom anyway** — Strapi adds framework overhead without adding capability.

## Decision

Replace the Strapi backend with a new Node service built on:

- **Hono** — HTTP framework (TypeScript-first, ~20KB, runs Node/Bun/edge)
- **Drizzle** — ORM with schema-as-code (TypeScript), migrations via drizzle-kit
- **PostgreSQL 17** — unchanged
- **pg-boss** — job queue on Postgres (per [ADR 0006](0006-pg-boss-for-job-queue.md))
- **`ws`** — raw WebSocket library + custom room manager
- **`@modelcontextprotocol/sdk`** — official MCP server
- **Custom auth** — `jose` (JWT) + `argon2` + shared policy module for dual principals (per [ADR 0005](0005-dual-principal-auth.md))
- **Nodemailer + SMTP** — email sending
- **Qdrant** — unchanged, still the vector store

Admin UI strategy:
- **Drizzle Studio** for dev (free, auto-generated from schema)
- **Custom `/admin` routes in the existing Next.js web app** for production self-hosters

## Rationale

- **TypeScript end-to-end** — no JSON schemas separate from code.
- **Single lightweight Node process** — ~100MB RAM baseline vs ~400MB for Strapi.
- **Self-host simplicity preserved** — same docker-compose shape: Postgres + Qdrant + one service. No Redis required (pg-boss).
- **Modern but not bleeding-edge** — Hono and Drizzle have been production-ready since 2023; no early-adopter risk.
- **OSS-friendly licensing throughout** — no AGPL or commercial dependencies in core.
- **Clear migration path** — scoped to one service; can be done incrementally alongside Strapi during the transition.

## Alternatives considered

1. **Stay on Strapi for v0.1, migrate at v1.0** — rejected: migration cost compounds as users arrive; "why Strapi?" adoption objection doesn't wait for v1.0.
2. **Extract the control-plane core, keep Strapi for CRUD admin** — rejected: two services add operational complexity; Strapi is still in the contributor's way; doesn't solve the upgrade treadmill.
3. **Full rewrite with NestJS** — rejected: NestJS is "Strapi-without-the-CMS" — same heaviness, same enterprise patterns, same OSS friction.
4. **Fastify + Prisma** — rejected: Prisma's query engine binary inflates container size and introduces a non-Apache dependency friction point.
5. **Elysia + Bun** — rejected: Bun is first-class for Elysia but the Node ecosystem is more contributor-familiar for v0.x. Hono supports Bun if we want to migrate later.
6. **Go rewrite** — rejected: TypeScript is the project's primary language; forcing contributors into Go is a step backward.

## Consequences

### Positive
- Critical workload (WS, jobs, events) runs on a framework designed for it
- Lower memory footprint → smaller VPS requirements for self-hosters
- Contributor onboarding: "read any modern TS app"
- Admin UI becomes purpose-built instead of generic Strapi admin
- No framework upgrade treadmill — library versions managed independently

### Negative
- Migration is ~5–7 weeks of work in Phase 2, extending public launch from week 19 → week 22–24
- We lose Strapi admin's free user CRUD UI — must build equivalent in Next.js web app
- Schema migration script is one-shot and risky (acceptable at pre-1.0)
- Users on a pre-migration snapshot must run the migration to upgrade

### Neutral
- Docker-compose service count unchanged (Postgres + Qdrant + Jarvis service)
- API surface stays compatible where possible; device agents only care about the auth + WS + job event protocol

## Migration plan (high level)

| Phase | Duration | Output |
|-------|----------|--------|
| 2.1 | 2 weeks | Core service skeleton: Hono + Drizzle + schema + auth + WS + MCP |
| 2.2 | 2 weeks | Port critical path: job queue, dispatcher, JobEvent ingestion |
| 2.3 | 1 week | Migration script (Strapi Postgres → Drizzle-managed tables) |
| 2.4 | 1 week | Cut over web client; Strapi read-only |
| 2.5 | 1 week | Remove Strapi from docker-compose; update docs |

Detail: RFC 0002 (to be drafted).

## Related

- Depends on: [ADR 0001](0001-device-runner-architecture.md) (the device-runner split is what makes this migration tractable; no agent execution in the service)
- Drives: future ADRs on admin UI scope, on schema versioning strategy
