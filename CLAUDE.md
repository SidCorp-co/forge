# Jarvis Agents

Full-stack project management + AI agent platform.

## Architecture

- **forge/** — Project management platform with 4 packages (no shared workspaces):
  - **forge/strapi/** — Strapi 5 backend: REST API, WebSocket, AI agent execution, MCP server
  - **forge/web/** — Next.js 16 cloud UI: project management, issue tracking, AI chat
  - **forge/dev/** — Tauri desktop app: local codebase access, Claude CLI agent, MCP support
  - **forge/app/** — React Native (Expo) mobile app: cross-platform project management

## Key Patterns

- TypeScript everywhere (Rust for Tauri backend only)
- All UI clients share the same Strapi REST API contract
- React Query for server state, Zustand for client state (dev/app)
- WebSocket real-time broadcasts from Strapi to all UIs
- Feature-based module organization: api/, types.ts, components/, hooks/
- Auth via Bearer token in Authorization header

## Data Flow

```
UI clients (web/dev/app) → Strapi REST (/api/*) → SQLite/Postgres
                                → Strapi WebSocket (/ws) → Real-time updates
                                → Agent Runner → Claude CLI / Cloud AI APIs
MCP clients → Strapi /mcp → Same data layer
```

## Commands

| Package | Dev | Build | Test |
|---------|-----|-------|------|
| strapi | `npm run develop` | `npm run build` | `npx vitest` |
| web | `npm run dev` | `npm run build` | `npx vitest` |
| dev | `npm run tauri dev` | `npm run tauri build` | `npx vitest` |
| app | `npm run start` | `expo build` | — |
