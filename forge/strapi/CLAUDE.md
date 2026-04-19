# Forge Strapi Backend

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
