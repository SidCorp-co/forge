# Forge Strapi Backend

> ⚠️ **Legacy — being removed.** Strapi is replaced by `forge/core` per [RFC 0002](../../docs/rfcs/0002-replace-strapi-with-hono-drizzle.md) and [docs/proposals/core-strapi-decoupling.md](../../docs/proposals/core-strapi-decoupling.md). Do not add new content types, endpoints, or features here. Bug fixes only until the Phase 2.5 flip PR deletes this package.

## Authoritative docs

- Replacement plan: [../../docs/rfcs/0002](../../docs/rfcs/0002-replace-strapi-with-hono-drizzle.md), [../../docs/proposals/core-strapi-decoupling.md](../../docs/proposals/core-strapi-decoupling.md)
- Decisions bound to current behavior: [ADR 0004](../../docs/decisions/0004-no-claude-credentials-on-server.md), [ADR 0005](../../docs/decisions/0005-dual-principal-auth.md), [ADR 0006](../../docs/decisions/0006-pg-boss-for-job-queue.md)
- Module docs (canonical for behavior, not file layout): [../../docs/modules/](../../docs/modules/)

Strapi 5 headless CMS with custom APIs, WebSocket, and multi-provider AI agent execution.

## Architecture

- `src/api/` — Content-type APIs (issue, task, project, chat, comment, usage-record)
- `src/services/agent/` — Agent runner with tools (forge_issues, forge_tasks, etc.)
- `src/services/websocket.ts` — WS broadcasts for real-time updates
- `src/lifecycles/` — Lifecycle hooks (issue, task, comment), registered in bootstrap
- `src/index.ts` — Bootstrap: registers WS, API permissions, lifecycle hooks

## Strapi v5 — NOT v4

- Use `strapi.documents(UID)` NOT `strapi.entityService`
- Use `documentId` (UUID string) NOT numeric `id`
- Lifecycle hooks: `strapi.db.lifecycles.subscribe()` in bootstrap, NOT exports in content-type files
- Before writing Strapi code, read `.claude/skills/strapi/rules/` for detailed patterns and conventions

## Commands

- `npm run develop` — Start dev server (port 1337)
- `npm run build` — Build for production
