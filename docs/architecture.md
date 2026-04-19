# Architecture

How Jarvis Agents is put together, and why.

The architectural foundation is [RFC 0001: Device-runner architecture](rfcs/0001-device-runner-architecture.md). This doc summarizes and explains; the RFC is authoritative.

## One-paragraph summary

Jarvis Agents splits into two planes:

- **Control plane** — a Strapi 5 backend exposing REST, WebSocket, and MCP. Hosts project and issue state, queues jobs, and streams events. **Never holds Claude credentials.**
- **Runtime plane** — **device agents** running on users' own machines. Two form factors share a Rust `agent-core` crate: `dev` (Tauri GUI) and `forged` (CLI daemon). Devices pair into the account, receive job dispatches over WebSocket, spawn the `claude` CLI locally in a git worktree, and stream JobEvents back.

Two principals interact with the system — **user** (JWT) and **device** (long-lived revocable token). Both pass through a shared policy layer so access checks live in one place.

## Component map

```
┌─────────────────────────────────────────────────────────┐
│                   Your browser / phone                  │
│           web (Next.js)     ── app (Expo, v0.2+)        │
└──────────────────────┬──────────────────────────────────┘
                       │ REST + WebSocket (user JWT)
                       │ MCP (user token or device token)
                       ▼
┌─────────────────────────────────────────────────────────┐
│               Control plane — Strapi                    │
│  ┌───────────┐ ┌───────────┐ ┌────────────────────────┐ │
│  │ REST /api │ │ WS /ws    │ │ MCP /mcp               │ │
│  └─────┬─────┘ └─────┬─────┘ └───────────┬────────────┘ │
│        └───────┬─────┴───────────────────┘              │
│                │ shared policy layer                    │
│                │ (user ▷ project member,                │
│                │  device ▷ project pool)                │
│        ┌───────▼────────┐   ┌────────────────────┐      │
│        │ Job dispatcher │   │ Lifecycle hooks    │      │
│        │ (pg-boss queue)│   │ (broadcast, index) │      │
│        └───────┬────────┘   └─────────┬──────────┘      │
│                │                      │                 │
│                ▼                      ▼                 │
│        ┌───────────────┐       ┌─────────────────┐      │
│        │ Postgres 17   │       │ Qdrant 1.13     │      │
│        │ state + jobs  │       │ embeddings      │      │
│        └───────────────┘       └─────────────────┘      │
└──────────────┬──────────────────────────────────────────┘
               │ WebSocket (device token)
               ▼
┌─────────────────────────────────────────────────────────┐
│       Runtime plane — Your machine(s)                   │
│  ┌──────────────────┐       ┌──────────────────┐        │
│  │ dev (Tauri GUI)  │   OR  │ forged (CLI)     │        │
│  │ for developers   │       │ for CI / daemons │        │
│  └────────┬─────────┘       └────────┬─────────┘        │
│           └──────────┬─────────────────┘                │
│                      ▼                                  │
│           ┌──────────────────────┐                      │
│           │ agent-core (Rust)    │                      │
│           │ pair / ws / keychain │                      │
│           │ git / job_runner     │                      │
│           └──────────┬───────────┘                      │
│                      ▼                                  │
│           ┌──────────────────────┐                      │
│           │ spawns `claude` CLI  │                      │
│           │ in git worktree      │                      │
│           └──────────────────────┘                      │
│           (Claude credentials in OS keychain, here)     │
└─────────────────────────────────────────────────────────┘
```

## Why this shape

### Split control plane from runtime

The server has the wrong lifetime to run agents. HTTP requests live for milliseconds; Claude Code jobs run for minutes to hours. Running agent execution in the same process that serves HTTP creates two problems:

1. Subprocess lifetime outlives requests — complex state management
2. Credentials for a powerful CLI sit next to all the HTTP attack surface

Pushing execution to paired devices solves both. The server becomes a thin coordinator. Claude credentials never leave the user's keychain.

### Two device form factors, one Rust core

The same `agent-core` crate handles pairing, WebSocket protocol, job dispatch, keychain access, and `claude` spawning. Two thin wrappers add the form-factor-specific bits:

- **`dev` (Tauri)** — desktop GUI with project picker, pairing UI, live job viewer. First-class for developer workstations.
- **`forged` (CLI daemon)** — headless, for CI runners, long-running dev boxes, or power users who prefer the terminal.

Both share the protocol. A team can use either, or both.

### Dual-principal authorization

Two actors call the API, and they deserve different trust:

- **User** (JWT, 7-day TTL, refresh rotation) — can read/write projects they own or are members of, enqueue jobs, revoke devices.
- **Device** (long-lived device token, revocable) — can accept jobs for projects where the device is pooled, submit JobEvents for jobs it's running, heartbeat. **Cannot** read user PII or enumerate projects outside its pool.

A single policy module exports helpers (`assertUserIsProjectMember`, `assertDeviceBelongsToProject`, `assertJobAccessibleByPrincipal`). REST, WebSocket, and MCP all call these helpers. No code path bypasses the policy layer.

### WebSocket with room-scoped broadcasts

Older versions broadcast every event to every connected client. The new model subscribes each socket to specific rooms on authentication:

- User socket → `user:<id>` + `project:<id>` for every project they're in
- Device socket → `device:<id>` + `project:<id>` for every project pool it's in

Clients cannot choose their own rooms. Events publish to rooms; fan-out is scoped.

### MCP on the same data layer

MCP clients (Claude Code itself, Cline, custom tools) reach the same data via `/mcp`. Tools are thin wrappers around REST controllers — same validation, same policy checks, same audit. User MCP tokens are **account-wide** (tool call must include `projectId`; policy enforces access); device MCP tokens are device-scoped.

## Data flow — a typical job

```
1. Webhook fires: GitHub issue opened (or Sentry alert, or Stripe event)
   → POST /api/webhooks/<project-id>
   → Server creates a Jarvis issue in status `open`

2. Pipeline triggers `forge-triage` job (if auto-triage is enabled for this project)
   → Job row inserted: {project, issue, type: 'triage', status: 'queued'}
   → Dispatcher picks the project's activeDevice
   → WS event `job.assigned` sent to the device's room

3. Device agent receives job:
   → agent-core spawns `claude` in the project's git worktree
   → Passes skill prompt + issue context
   → Streams stdout / stderr / tool calls back over WS

4. For each stream chunk:
   → Device POSTs batched JobEvent records to /api/jobs/:id/events
   → Server persists + broadcasts on project room
   → Web dashboard renders live

5. Claude finishes:
   → Device POSTs /api/jobs/:id/complete with exitCode + summary
   → Job status → `done` (or `failed`)
   → If pipeline has a next stage and that stage is auto-enabled, another job is enqueued
   → Otherwise issue waits for human approval
```

## Pipeline state machine

Issues move through 14 statuses:

```
draft → open → confirmed → clarified → waiting → approved →
in_progress → developed → deploying → testing → staging →
released → closed

with branches:
  reopen (max 5 cycles) → fix → back to developed
  on_hold, needs_info (manual)
```

Each transition can map to a skill:

| From → To | Triggering skill |
|-----------|------------------|
| `open → confirmed` | `forge-triage` — validate, classify, set priority |
| `confirmed → clarified` | `forge-clarify` — reproduce bugs, verify UX |
| `clarified → approved` | `forge-plan` — write implementation plan |
| `approved → deploying` | `forge-code` — implement, build, review, push |
| `deploying → testing` | `forge-review` — independent code review |
| `testing → staging` | `forge-test` — QA against preview deployment |
| `staging → released` | `forge-release` — merge to production |
| `reopen → deploying` | `forge-fix` — address rejection feedback |

Per-project config decides which transitions auto-trigger vs wait for human approval. User-authored skills can also register to stages.

## Security boundaries

- **Claude credentials never on the server.** They live in each device's OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- **User JWT:** 7-day TTL, refresh-token rotation, `httpOnly` cookies on web.
- **Device token:** long-lived, stored in OS keychain, revocable from the web UI.
- **Rate limits** on `/api/auth/*` and `/api/devices/pair`.
- **Email verification** required before creating the first project.
- **CORS:** whitelist + regex patterns via `CORS_ORIGINS` / `CORS_ORIGIN_PATTERNS`.
- **MCP `crossProjectAccess` flag removed** — every tool call must include `projectId` and pass the policy check.

## Non-goals

- **Not multi-tenant SaaS.** One Strapi instance = one tenant. Run multiple instances for multiple tenants.
- **Not optimized for >~1000 concurrent WS sockets** in a single instance. Beyond that, a Redis pub/sub layer will be added (v0.5+).
- **Not a Linux headless agent in v0.x.** Secret Service + D-Bus needs a follow-up RFC.
- **Not using the Anthropic API.** We orchestrate Claude Code CLI, the user's subscription.

## Evolution

Significant changes (new service, schema migration, new client form factor, new principal class) go through the RFC process. See [RFC 0001](rfcs/0001-device-runner-architecture.md) as the template.

See [ROADMAP.md](ROADMAP.md) for where we're headed.
