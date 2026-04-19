# Architecture

How Jarvis Agents is put together, and why.

## One-paragraph summary

Jarvis Agents is a Strapi 5 backend (REST + WebSocket + embedded MCP server) wrapped by three independent frontends (Next.js web, Tauri desktop, Expo mobile). Agents run inside Strapi via a pipeline of `forge-*` skills that mutate the same data the UIs read. Postgres stores structured data; Qdrant stores vector embeddings for memory/knowledge search.

## Component map

```
┌────────────────────────────────────────────────────────────┐
│                    Clients (any of three)                  │
│  web (Next.js) ── app (Expo) ── dev (Tauri desktop+Rust)   │
└──────────────────────┬─────────────────────────────────────┘
                       │ Bearer token auth
                       │ REST (HTTP)  +  WebSocket (/ws)
                       ▼
┌────────────────────────────────────────────────────────────┐
│              Strapi 5 backend  (forge/strapi)              │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │ REST API    │  │ WebSocket hub │  │ MCP server (/mcp)│  │
│  │ /api/*      │  │ /ws           │  │ Streamable HTTP  │  │
│  └──────┬──────┘  └───────┬───────┘  └────────┬─────────┘  │
│         │                 │                   │            │
│         └────────┬────────┴───────────────────┘            │
│                  │                                         │
│         ┌────────▼─────────┐   ┌──────────────────┐        │
│         │ Lifecycle hooks  │   │ Agent Runner     │        │
│         │ (broadcast,      │   │ Claude CLI       │        │
│         │  audit, index)   │   │ / Antigravity    │        │
│         └────────┬─────────┘   └────────┬─────────┘        │
└──────────────────┼──────────────────────┼──────────────────┘
                   │                      │
         ┌─────────▼──────┐      ┌────────▼──────┐
         │  Postgres 17   │      │  Qdrant 1.13  │
         │  structured    │      │  embeddings   │
         └────────────────┘      └───────────────┘
```

## Why this shape

### Strapi as the backend

- **Schema-first** — content types are declarative; generates REST + admin UI for free.
- **Lifecycle hooks** — natural place to broadcast WebSocket events when data changes.
- **Extensibility** — custom services and routes for agent orchestration sit alongside CRUD cleanly.
- **Tradeoff** — less control than a handwritten Express/Fastify app; heavier than we'd write from scratch.

### Four clients, shared REST API

- Web, desktop, mobile share **one API contract**. No BFF, no GraphQL layer.
- Forces the backend to be the single source of truth. Clients are interchangeable.
- Tauri desktop adds local capabilities the web can't have: filesystem access, git worktrees, Claude CLI spawn.
- Mobile (Expo) is last in the priority order — parity, not innovation.

### WebSocket for real-time

- Strapi broadcasts `issue:*`, `comment:*`, `chat:*`, `agent:*` events on lifecycle.
- All connected clients subscribe. No polling.
- Tauri uses an IPC proxy to the Strapi WS so the Rust side can forward events to the UI.

### MCP embedded in Strapi

- Same data layer, different surface. MCP clients (Claude Code, Cline, etc.) reach Strapi at `/mcp`.
- The MCP tools (`forge_issues`, `forge_skills`, `forge_memory`) are thin wrappers around existing REST controllers.
- Allows agents to manipulate the same data they were created to work on.

## Data flow — a typical issue

```
1. User types "fix the chat reconnect bug" in web UI
2. POST /api/issues  with {title, projectId, priority, ...}
3. Strapi persists row in Postgres
4. Lifecycle hook fires:
     - embed title+description → insert into Qdrant
     - WS broadcast `issue:created` to all subscribers
     - if auto-triage enabled: enqueue agent run
5. Agent Runner spawns Claude CLI / calls Antigravity
     - Session streams chunks back via WS `agent:chunk`
     - Tools called: forge_issues.update, forge_comments.create
     - On complete: WS `agent:complete` with summary
6. UI receives updates, re-renders
```

## Agent pipeline

Issues move through 14 statuses:

```
draft → open → confirmed → clarified → waiting → approved →
in_progress → developed → deploying → testing → staging →
released → closed

with branches:
  reopen (max 5 cycles) → fix → back to developed
  on_hold, needs_info (manual)
```

Each transition can trigger an agent:

| From → To | Triggering skill |
|-----------|------------------|
| `open → confirmed` | `forge-triage` — validate, classify, set priority |
| `confirmed → clarified` | `forge-clarify` — reproduce bugs, verify UX |
| `clarified → approved` | `forge-plan` — write implementation plan |
| `approved → deploying` | `forge-code` — implement, build, review, push |
| `deploying → testing` | CI + `forge-review` — independent code review |
| `testing → staging` | `forge-test` — QA against preview deployment |
| `staging → released` | `forge-release` — merge to production, deploy |

Skills live in `.claude/skills/` (per-project) and `~/.claude/skills/` (global).

## Security boundaries

- **Authentication:** Bearer token in `Authorization` header. Tokens are per-user, project-scoped.
- **MCP auth:** `X-Forge-API-Key` header — project-scoped, reduced scope.
- **Widget/chat public endpoints:** accessible with project API key (no user auth) — only for embedded widgets.
- **CORS:** whitelist-based, `CORS_ORIGINS` env var. Pattern-based via `CORS_ORIGIN_PATTERNS` for dynamic domains.
- **Agent execution:** sessions are logged; each run has an audit trail in `agent_sessions` table.

## Non-goals

- **Not multi-tenant SaaS.** One Strapi instance = one workspace. Host multiple copies for multiple workspaces (Phase v0.4+ may revisit).
- **Not optimized for >100 concurrent users** in single deployment — scale by running multiple Strapi replicas + Postgres read replicas.
- **Not plugin-based** today. Skills are extensibility for agents; code extensibility is via forking.

## Evolution

The architecture is stable but opinionated. Significant changes (new service, schema migration, new client) go through the RFC process — see [proposal-drafter skill](../.claude/skills/oss-proposal-drafter/SKILL.md).

See [ROADMAP.md](ROADMAP.md) for where we're headed.
