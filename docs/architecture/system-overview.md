# Architecture

Canonical map of how Forge is laid out: control plane vs runtime, the device-runner split, dual-principal auth.

## Two planes

- **Control plane** — `packages/core` (Hono + Drizzle): REST, WebSocket, MCP. Holds project/issue state, queues jobs (pg-boss), embeddings (pgvector), streams events. **Never holds Claude credentials.**
- **Runtime plane** — device agents on users' machines: `forge-runner` (Rust CLI daemon). Pairs into the account, receives jobs over WS, spawns `claude` CLI in a git worktree, streams JobEvents back.

Two principals, one shared policy layer: **user** (JWT) and **device** (long-lived revocable token).

## Component map

```mermaid
flowchart TB
  B["browser — web-v2 (Next.js)"]

  subgraph CP["CONTROL PLANE — packages/core (Hono) · your server"]
    direction TB
    E["REST /api · WS /ws · MCP /mcp"]
    P["shared policy layer<br/>user ▷ project member · device ▷ project pool"]
    D["job dispatcher (pg-boss)<br/>event broadcaster (room-scoped WS)"]
    DB[("Postgres 17<br/>state · jobs · embeddings (pgvector)")]
    E --> P --> D --> DB
  end

  subgraph RP["RUNTIME PLANE — your machine(s)"]
    direction TB
    R["forge-runner (CLI daemon)"]
    RC["forge-runner-core (Rust)<br/>pair · ws · keychain · git · job_runner"]
    C["spawns the claude CLI in a git worktree"]
    K[["Claude credentials<br/>OS keychain — ONLY here"]]
    R --> RC --> C --- K
  end

  B -- "REST + WS (user JWT) · MCP (user/device token)" --> E
  D -- "WS (device token)" --> R
```

## Non-goals

- Not multi-tenant SaaS (one instance = one tenant). Not tuned for >~1000 concurrent WS sockets (Redis pub/sub later). Not the Anthropic API — orchestrates the user's Claude Code CLI.
