# Forge Monorepo

Forge is a project management + AI agent platform. See repo-root [CLAUDE.md](../CLAUDE.md) for current state, ongoing migrations, and the "before you start a task" reading map.

## Packages

- **core/** — Hono + Drizzle backend (the control plane per [RFC 0002](../docs/rfcs/0002-replace-strapi-with-hono-drizzle.md))
- **web/** — Next.js cloud UI
- **dev/** — Tauri desktop app
- **app/** — React Native (Expo) mobile — **paused per [ADR 0009](../docs/decisions/0009-mobile-app-paused-for-v0x.md)**

## Authoritative docs

- System overview + flows: [../docs/architecture/](../docs/architecture/)
- Per-feature module docs: [../docs/modules/](../docs/modules/)
- Decisions that bind every package: [../docs/decisions/](../docs/decisions/)
- In-flight changes: [../docs/proposals/](../docs/proposals/)

## Data Flow

```
web/dev → core REST (/api/*) → Postgres (data + jobs + pgvector)
          core WebSocket (/ws) → room-scoped real-time broadcasts
          core Job dispatcher  → device-runner (packages/dev) → Claude CLI
MCP clients → core /mcp → same handlers as REST
```

## Shared Conventions

- TypeScript everywhere (Rust for Tauri backend)
- Issue lifecycle: open → confirmed → clarified → approved → in_progress → developed → deploying → testing → tested → pass → staging → released → closed (reopen → fix → developed, max 5 cycles). Detail in [../docs/modules/issues-pipeline/status-pipeline.md](../docs/modules/issues-pipeline/status-pipeline.md). Local-only mode (no Coolify, no preview) stops at `developed` for human review.
- Branching: ISS-* branch lives across the pipeline. Merges to baseBranch (staging) for testing. Squash-merges to productionBranch at release. Never merge baseBranch → productionBranch directly.
- Task statuses: backlog → todo → in_progress → in_review → done
- Auth via Bearer token in Authorization header
