# Phase 2.7-F1 — `forge/dev` compat review

Audit of Strapi-era assumptions in `forge/dev` vs `forge/core` equivalents delivered in this issue.

The table below is the source of truth for follow-up work. Each row either
points to a section of this issue's plan that fixes it, or is flagged for a
follow-up issue.

| Strapi-era assumption | Where in `forge/dev` | `forge/core` replacement | Status |
|---|---|---|---|
| `desktop:register` WS beacon | `src-tauri/src/websocket/mod.rs:29–34,78–82` | `Authorization: Bearer <device-token>` header + `subscribe` room | Fixed (§3) |
| `POST /api/agent-sessions/:id/relay` | `src/lib/api/agent-sessions.ts:68–77` | `POST /api/jobs/:id/events` (batched) | Fixed (§4 scaffold) |
| `POST /api/agent-sessions/start`, `/send`, `/prompt-built` | `src/lib/api/agent-sessions.ts:3–31, 79–88` | No direct equivalent — job enqueue via `POST /api/projects/:id/jobs` | **Follow-up**: UX rework. Helpers preserved as dead code until the cloud UI is migrated off Strapi (ISS-TBD). |
| `POST /api/devices/register`, `/projects-root`, `/project-path` | `src/lib/api/agent-sessions.ts:47–66` | `POST /api/devices/pair` (§1) + project paths move to local client state | Fixed (§1 server) + follow-up for per-project path sync |
| Strapi `{data,meta}` envelope | `src/lib/api/client.ts:16–28` | Bare JSON response | Fixed (§3 — client.ts edit) |
| User JWT used for device-scoped calls | `src/lib/api/client.ts:21` | Device token for device-auth paths (heartbeat, job events) | Fixed (§3 + §5) |
| `deviceId` + `authToken` persisted plaintext | `src-tauri/src/config/mod.rs:98–129` | Token in OS keychain; `deviceId` non-secret in `AppConfig`; `authToken` dropped on load | Fixed (§5) |
| `/api/knowledge/ingest`, `/api/upload` | `src/lib/api/misc.ts` | Unverified in core | **Follow-up**: verify core parity (ISS-TBD) |
| `strapiUrl` field in `AppConfig` | `src-tauri/src/config/mod.rs:99` | `coreUrl` field; `strapiUrl` accepted on load for backwards compat then dropped | Fixed (§5) |

## Grep checklist

Run before marking forge/dev clean of Strapi assumptions:

```
grep -rn "agent-sessions\|/api/devices/\(register\|projects-root\|project-path\)\|strapiUrl\|desktop:register\|json.data ?? json\|deviceClients" forge/dev/
```

## Deferred items

These are NOT blockers for the F1 vertical slice, but are tracked here so the
compat story is complete:

- **Agent session lifecycle** — `startAgentSession`, `sendAgentSession`,
  `relayPromptBuilt` have no direct port. The Strapi version kept a
  server-side "session" entity; core models the same user intent as a Job with
  event stream. The UX rework (sidebar chat against a Job instead of an
  AgentSession) is a standalone ISS.
- **Per-project repo path sync** — `setDeviceProjectPath` /
  `setDeviceProjectsRoot` pushed local paths to Strapi so the web UI could
  read them. Core does not yet carry that concept. Two options: (a) store on
  the device row (`capabilities.projectPaths`), (b) keep purely local. ADR
  needed.
- **`GET /api/devices` + `DELETE /api/devices/:id`** — user-facing list /
  revoke not in this issue's AC. Needed before the admin Devices tab can
  function — deferred to a Phase 2.7 follow-up.
- **`PUT /api/projects/:id/runtime/active-device`** — explicit rebind of
  `activeDeviceId`. Pair flow auto-binds on first pair; the rebind endpoint
  is separate.
- **Server-side WS auth enforcement** — the Phase 2.2 enforcement flip of
  `src/ws/server.ts:31–35` is tracked independently. Client sends the header
  now; anonymous sockets are still accepted.

## What this issue delivers

- §1 server pair flow (`POST /api/devices/pair`, `POST /api/projects/:id/devices/pairing-codes`, `POST /api/devices/heartbeat`) + device-stale detector cron.
- §2 this document.
- §3 `forge/dev` WS client: device-token `Authorization` header, drop `desktop:register`, room `subscribe`.
- §4 Rust-owned JobEvent batcher scaffold (cadence 32/500 ms, cap 100, 5xx retry).
- §5 `keyring`-backed OS keychain for the device token; `AppConfig` scrubbed (`strapiUrl`→`coreUrl`, `authToken` dropped); `pair_device` Tauri command.
