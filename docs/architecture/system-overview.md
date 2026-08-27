# Architecture

Canonical map of how Forge is laid out: control plane vs runtime, the device-runner split, dual-principal auth.

## Two planes

- **Control plane** — `packages/core` (Hono + Drizzle): REST, WebSocket, MCP. Holds project/issue state, queues jobs (pg-boss), embeddings (pgvector), streams events. **Never holds Claude credentials.**
- **Runtime plane** — device agents on users' machines: `forge-runner` (Rust CLI daemon). Pairs into the account, receives jobs over WS, spawns `claude` CLI in a git worktree, streams JobEvents back.

Two principals, one shared policy layer: **user** (JWT) and **device** (long-lived revocable token).

## Component map

```
browser: web-v2 (Next.js)
   │ REST + WS (user JWT) · MCP (user/device token)
   ▼
control plane — packages/core (Hono)
   REST /api · WS /ws · MCP /mcp
   └─ shared policy layer (user ▷ project member · device ▷ project pool)
   └─ job dispatcher (pg-boss) · event broadcaster (room-scoped ws)
   └─ Postgres 17: state + jobs + embeddings (pgvector)
   │ WS (device token)
   ▼
runtime plane — your machine(s)
   forge-runner (CLI daemon)
   └─ forge-runner-core (Rust): pair / ws / keychain / git / job_runner
   └─ spawns `claude` CLI in git worktree  (Claude creds in OS keychain, here)
```

## Why this shape

- **Control plane ≠ runtime.** HTTP requests live ms; Claude jobs run minutes–hours. Pushing execution to paired devices keeps core a thin coordinator and keeps Claude credentials in the user's keychain, off the server's attack surface.
- **One Rust core, two wrappers.** `forge-runner-core` does pairing/WS/dispatch/keychain/spawn; `dev` adds a GUI, `forge-runner` is headless (CI, dev boxes).
- **Dual-principal auth.** User (JWT, 7-day TTL, refresh rotation): read/write own/member projects, enqueue jobs, revoke devices. Device (revocable token): accept jobs for pooled projects, submit JobEvents, heartbeat — **cannot** read user PII or enumerate projects outside its pool. One policy module (`lib/authz.ts` — `assertProjectAccess(projectId, userId, minRole)`) gates REST + WS + MCP; no path bypasses it.
- **Room-scoped WS.** Sockets are subscribed to rooms at auth (`user:<id>`, `project:<id>`, `device:<id>`); clients can't pick rooms. See [websocket.md](websocket.md).
- **MCP on the same data layer.** Tools wrap REST controllers (same validation/policy/audit). User MCP tokens are account-wide (call must include `projectId`); device tokens are device-scoped.
- **Organizations.** `packages/core/src/orgs/`, mounted `/api/orgs` + `/api/org-invitations`; two-tier org+project RBAC layered over the per-project membership policy.
- **Workspace resources — Private Keys pool.** `packages/core/src/orgs/ssh-keys-*` (mounted `/api/orgs`) + `packages/core/src/projects/git-credential-routes.ts`; an org-scoped, vault-encrypted `workspace_ssh_keys` pool that replaced per-project deploy keys, with `project_git_credentials` as a thin `(project_id, ssh_key_id)` reference. See [modules/resources](../modules/resources/README.md).
- **Integrations framework.** `packages/core/src/integrations/{coolify,epodsystem,postman,rocketchat,sentry}/`, mounted `/api/integration-connections`; pluggable adapters spanning inbound + outbound third-party systems (deploy, chat, error-tracking, API testing). `rocketchat` is an inbound chat provider (`startRocketChatManager`); `sentry` ingests inbound events / injects MCP.
- **Memory cognitive layer.** `packages/core/src/memory/` (consolidation/decay/extraction/indexer), mounted `/api/memory`; the pgvector embeddings store feeds this layer for recall, consolidation, and decay.
- **Chat provider subsystem.** `packages/core/src/chat/` (`/api/chat`, `run-turn-core.ts` tool-calling loop) + the Rocket.Chat inbound provider; flag-gated conversational access to project agents.

## Data flow — a typical job

1. Webhook → `POST /api/webhooks/in/<project-slug>` → issue created `open`.
2. Pipeline enqueues `forge-triage` (if `autoTriage`): job row `{project, issue, type, queued}` → dispatcher picks an eligible runner → `job.assigned` to device room.
3. Device: `forge-runner-core` spawns `claude` in the git worktree with skill prompt + issue context; streams stdout/tool-calls back over WS.
4. Per chunk: device batches `POST /api/jobs/:id/events` → core persists + broadcasts on project room → dashboard renders live.
5. Done: `POST /api/jobs/:id/complete` (exit + summary) → status `done`/`failed` → next auto-enabled stage enqueues, else waits for human.

## Pipeline state machine

16 statuses in `packages/core/src/db/schema.ts` (`issueStatuses`). Lifecycle, transitions, and skill mapping: [status-pipeline.md](../modules/issues-pipeline/status-pipeline.md) (source of truth). Per-project `pipelineConfig.auto*` decides auto-run vs human gate.

## Security boundaries

- Claude credentials only in each device's OS keychain — never on the server.
- User JWT: 7-day TTL, refresh rotation, `httpOnly` cookies.
- Device token: long-lived, OS keychain, revocable from web UI.
- Rate limits on `/api/auth/*` + `/api/devices/pair` (`RATE_LIMIT_*` env; defaults in `config/rate-limits.ts`).
- Email verification before first project. CORS via `CORS_ORIGINS`.
- MCP: no cross-project flag — every call includes `projectId` + passes policy.

## Observability — Sentry (opt-in)

**OSS contract**: every Sentry init reads its DSN from env at build/run time. Source builds without
those env vars compile cleanly with the SDK no-op'd — cloning and building never silently reports
anywhere. Only official release artifacts bake DSNs (via CI secrets); self-hosted operators opt in
by setting the env var in their own deploy environment.

| Service | Init location | Enable via |
|---------|---------------|-----------|
| backend (Hono) | `packages/core/src/observability/sentry.ts` | runtime `SENTRY_DSN` |
| cloud UI (Next.js) | `packages/web-v2/src/providers/sentry-init.tsx` | build-time `NEXT_PUBLIC_SENTRY_DSN` |

All payloads pass through a scrubber that replaces Authorization, X-Device-Token, Cookie, X-API-Key
headers; `authToken`/`auth_token`/`jwt`/`apiKey`/`api_key`/`password`/`token` body fields; and
tokenized URL query params with `[Filtered]`.

## Non-goals

- Not multi-tenant SaaS (one instance = one tenant). Not tuned for >~1000 concurrent WS sockets (Redis pub/sub later). No Linux headless agent in v0.x. Not the Anthropic API — orchestrates the user's Claude Code CLI.

## Evolution

New service / schema migration / client form factor / principal class → [RFC](../rfcs/README.md). In-flight work: issue tracker.
