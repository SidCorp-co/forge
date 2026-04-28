# Architecture Decision Records (ADRs)

Append-only log of significant technical decisions. Each ADR captures:

- **Context** — the problem at the time
- **Decision** — what was chosen
- **Rationale** — why, plus alternatives considered
- **Consequences** — what this makes easy / hard afterwards

ADRs are **never edited after acceptance**. If a decision is reversed, write a new ADR that supersedes the old one.

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-device-runner-architecture.md) | Adopt device-runner architecture | Accepted | 2026-04-19 |
| [0002](0002-replace-strapi-with-hono-drizzle.md) | Replace Strapi backbone with Hono + Drizzle service (full rewrite, no migration) | Proposed | 2026-04-20 |
| [0003](0003-claude-code-cli-as-primary-runner.md) | Claude Code CLI as primary runner (not Anthropic API) | Accepted | 2026-04-19 |
| [0004](0004-no-claude-credentials-on-server.md) | Server never holds Claude credentials | Accepted | 2026-04-19 |
| [0005](0005-dual-principal-auth.md) | Dual-principal authorization (user + device) | Accepted | 2026-04-19 |
| [0006](0006-pg-boss-for-job-queue.md) | pg-boss for job queue (no Redis dependency) | Accepted | 2026-04-19 |
| [0007](0007-apache-2-license.md) | Apache-2.0 license for the project | Accepted | 2026-04-18 |
| [0008](0008-english-as-primary-language.md) | English as the primary language for public docs | Accepted | 2026-04-19 |
| [0009](0009-mobile-app-paused-for-v0x.md) | Mobile app paused for v0.x | Accepted | 2026-04-19 |
| [0010](0010-clean-break-from-strapi.md) | Clean break from Strapi to `packages/core` (no parity, no dual-run) | Accepted | 2026-04-23 |
| [0011](0011-pgvector-replaces-qdrant.md) | Postgres `pgvector` replaces Qdrant for vector storage | Accepted | 2026-04-23 |
| [0012](0012-web-api-client-shape.md) | Web API client shape | Accepted | — |
| [0013](0013-widget-api-key-storage.md) | Widget API key storage | Accepted | — |
| [0014](0014-trunk-based-development.md) | Trunk-Based Development (single trunk, no `develop`/release branches) | Accepted | 2026-04-26 |

## Status values

- **Proposed** — under discussion, not yet committed
- **Accepted** — in force
- **Superseded by N** — replaced by ADR #N
- **Deprecated** — no longer recommended, but not replaced

## How to write a new ADR

1. Copy the template format from any existing ADR
2. Number it sequentially (next = 0010)
3. Use a short title: `NNNN-kebab-case-title.md`
4. Commit with message: `docs(adr): NNNN <title>`
5. Link it in this index

RFCs that affect API/architecture/cross-team surfaces go through [rfcs/](../rfcs/) first. When an RFC is accepted, summarize as an ADR here. Long-form design lives in the RFC; the ADR is the short decision record.
