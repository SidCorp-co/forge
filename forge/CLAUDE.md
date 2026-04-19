# Forge Monorepo

Forge is a project management + AI agent platform. Four independent packages, no shared workspaces.

## Packages

- **strapi/** — Strapi 5 backend: REST API, WebSocket, AI agent execution
- **web/** — Next.js cloud UI: project management, issue tracking, chat
- **dev/** — Tauri desktop app: local codebase access, agent execution, MCP support
- MCP server is embedded in Strapi at `/mcp` (Streamable HTTP transport)

## Data Flow

```
web/dev UI → Strapi REST API (/api/*) → Database (SQLite/Postgres)
             Strapi WebSocket (/ws)   → Real-time broadcasts to UIs
             Strapi Agent Runner      → Claude CLI / Cloud APIs
MCP Server → Strapi REST API          → Same data layer
```

## Shared Conventions

- TypeScript everywhere (Rust for Tauri backend)
- Issue lifecycle: draft (agent-created) → open → confirmed → clarified (Simple auto-skips) → waiting (Complex only) → approved → in_progress → developed → deploying → testing → staging → released → forge-release (merge ISS-* to productionBranch) → closed (reopen → fix → developed, max 5 cycles)
- Branching: ISS-* branch kept alive through pipeline. Merges to baseBranch (staging) for testing. Squash-merges to productionBranch (master) at release. Never merge baseBranch → productionBranch directly.
- Task statuses: backlog → todo → in_progress → in_review → done
- All packages use the same Strapi REST API contract
- Auth via Bearer token in Authorization header
