# Forge Desktop App

Tauri desktop app with React frontend. Local codebase access, agent execution, MCP server support.

## Authoritative docs

- Device-runner architecture: [ADR 0001](../../docs/decisions/0001-device-runner-architecture.md), [docs/modules/devices/](../../docs/modules/devices/)
- Claude CLI as runner: [ADR 0003](../../docs/decisions/0003-claude-code-cli-as-primary-runner.md); credential boundary: [ADR 0004](../../docs/decisions/0004-no-claude-credentials-on-server.md)
- Agent + job flow: [docs/modules/agents-jobs/](../../docs/modules/agents-jobs/)
- Backend is `forge/core` (Hono + Drizzle) per [RFC 0002](../../docs/rfcs/0002-replace-strapi-with-hono-drizzle.md). Strapi was removed at Phase 2.8-F1 — write all API code against `core`'s response shape (no `{ data, meta }` envelope).

## Architecture

- `src-tauri/src/` — Rust backend: CLI spawning, config, WebSocket proxy
  - `claude_cli/agent.rs` — Run Claude CLI agents, knowledge indexing
  - `claude_cli/spawn.rs` — Process spawning + stream parsing
  - `claude_cli/mcp.rs` — MCP config file generation
- `src/pages/` — React pages: dashboard, project issues/board/chat, settings
- `src/components/` — UI components: issue detail, chat sidebar, settings panels
- `src/stores/app-store.ts` — Zustand store (auth, config, projects)
- `src/lib/api.ts` — Forge core API client
- `src/lib/types.ts` — Shared TypeScript types

## Key Patterns

- Tauri IPC via `@tauri-apps/api` for local operations (invoke commands)
- Zustand for client state, React Query for server state
- Agent sessions stream via `agent:chunk` / `agent:complete` Tauri events
- Per-project MCP server configuration
- Knowledge indexing generates `.forge/knowledge.json` per repo

## Recipes

**Add Tauri command:**
1. Add Rust function in `src-tauri/src/` with `#[tauri::command]`
2. Register in `main.rs` invoke_handler
3. Call from React via `invoke("command_name", { args })`

**Add new page:**
1. Create page component in `src/pages/`
2. Add route in `src/App.tsx`

## Commands

- `npm run tauri dev` — Dev mode (React + Tauri)
- `npm run tauri build` — Build distributable
