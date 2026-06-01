# Devices

Paired machines running `claude` CLI locally — the runtime plane's connection point to the control plane.

## Overview

- User pairs devices (laptop, desktop, CI box) with their account; each installs the Forge agent (Tauri `dev` app or the `forge-runner` CLI).
- A device is assigned to a project via the runners framework: assign the device in the web UI, then bind it locally with `forge-runner bind`.

## Data Flow

```
  User runs `forge-runner login` on the machine
        │
        ▼ (default: browser device-authorization flow)
  CLI POST /api/devices/login/init → pairing code + verify URL
        │
        ▼ user approves in browser; CLI polls GET /api/devices/login/poll
  Server approves, issues device token (argon2-hashed in DB)
        │
        ▼ (paste-code variant: `forge-runner login --code <CODE>`)
  POST /api/devices/pair { code, name, platform, capabilities }
        │
        ▼
  Device stores token in OS keychain
  (macOS Keychain / Windows Credential Manager / Linux Secret Service)
        │
        ▼
  Device opens WebSocket with token
        │
        ▼
  Server authenticates, subscribes socket to rooms:
    - device:<id>
    - project:<id> for every project the device is assigned to (via `runners`)
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| pairing code | `forge-runner login` (browser flow) or project mint | Short-lived, one-time-use |
| device name, platform | Device agent on pair | User-provided name, OS auto-detected |
| capabilities | Device agent on pair | `{ claudeCode: { version, available }, git, node }` |
| heartbeat | Device agent every 30s | Updates `lastSeenAt`, `agentVersion`, `status` |

### ID Resolution

| Input | Transform | Stored as |
|-------|-----------|-----------|
| Pairing code | Validated + one-time-consumed | Device token (argon2 hashed) |
| Device name (user input) | Unique per user | `device.name` |

## Core Entities

### `Device`

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `owner` | User who paired this device |
| `name` | User-provided, e.g. `macbook-pro` |
| `platform` | `macos` \| `linux` \| `windows` |
| `agentVersion` | Version of the Forge agent running on the device |
| `tokenHash` | argon2 hash of the device token (never stored plaintext) |
| `tokenPrefix` | First 8 chars for UI display |
| `status` | `online` \| `offline` \| `revoked` |
| `lastSeenAt` | Last heartbeat |
| `pairedAt` | Initial pair timestamp |
| `capabilities` | Snapshot of `{ claudeCode, git, node }` |

Status transitions:

```
(new) → online ↔ offline → revoked (terminal)
```

### `PairingCode` (ephemeral)

5-min TTL, single-use, bound to `ctx.state.user`. Not a user-facing entity.

## Key Business Flows

### First-time pair

1. User installs the agent and runs `forge-runner login` on the machine.
2. **Default (browser):** CLI calls `POST /api/devices/login/init`, prints a pairing code + verify URL, and opens the browser; user approves and the CLI polls `GET /api/devices/login/poll` until the device token is issued.
3. **Paste-code variant:** user mints a project code in the web UI (`POST /api/projects/:id/devices/pairing-codes`) and runs `forge-runner login --code <CODE>`, which redeems it via `POST /api/devices/pair { code, name, platform, capabilities }`.
4. Agent stores the device token in the OS keychain, opens WS.
5. Device appears online in the web UI.

### Project binding

Project↔device routing is expressed through the **runners framework** (`runners` table + `/api/runners`); there is no single "active device" field.

1. Assign the device to the project in the web UI (creates a runner row for the project↔device pair).
2. On the machine, run `forge-runner bind <slug> --path <dir>`.
3. The CLI resolves the assignment via `GET /api/devices/me/runners` (refusing slugs not assigned to this device) and pushes the local repo path via `PATCH /api/devices/me/runners/:runnerId` (device principal).

### Heartbeat + online / offline detection

1. Device sends `POST /api/devices/heartbeat` every 30s → server updates `lastSeenAt`
2. Cron every 2 min: marks devices with `lastSeenAt > 90s ago` as `offline`
3. On next heartbeat: `status → online`

### Revocation

1. User clicks **Revoke** on device card → `DELETE /api/devices/:id`
2. Server sets `status = revoked`, invalidates `tokenHash`, closes the device's WebSocket
3. Any `running` jobs on this device get `cancelled` with reason `device_revoked`
4. Next reconnect attempt: 401, device surfaces "Device revoked, please re-pair"

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/projects/:id/devices/pairing-codes` | user | Mint a project-scoped pairing code |
| `POST` | `/api/devices/pair` | public | Device redeems pairing code (paste-code login) |
| `POST` | `/api/devices/login/init` | public | Start browser device-authorization login |
| `GET` | `/api/devices/login/poll` | public | Poll for browser-login approval |
| `GET` | `/api/me/devices` | user | List the user's devices |
| `PATCH` | `/api/devices/:id` | user | Update a device |
| `DELETE` | `/api/devices/:id` | user | Revoke |
| `POST` | `/api/devices/heartbeat` | device | Update `lastSeenAt` |
| `GET` | `/api/devices/me/runners` | device | Device self-reports its project assignments |
| `PATCH` | `/api/devices/me/runners/:runnerId` | device | Push repo path / branch for a binding (used by `forge-runner bind`) |
| `GET` | `/api/devices/:id/runners` | user | List a device's runners |
| `GET` / `PATCH` | `/api/runners` , `/api/runners/:id` | user | Runners framework — web-UI surface to list/update project↔device bindings |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Emits to | [agents-jobs](../agents-jobs/README.md) | WebSocket `job.accept` | On receiving `job.assigned` |
| Emits to | [agents-jobs](../agents-jobs/README.md) | JobEvent batches | During execution |
| Receives from | [agents-jobs](../agents-jobs/README.md) | WebSocket `job.assigned`, `job.cancel` | On dispatch / cancellation |
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Project binding request | User assigns a device to a project (runner) |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `desktop-pairing-cleanup` (cron, hourly at :15) | Delete expired/consumed `desktop_pairing_codes` (browser-login codes) |
| `device-status-detector` (cron 2m) | Mark offline devices whose heartbeat has lapsed (90s threshold) |
| `device-offline-prune` (cron, daily 04:00) | Revoke devices offline > 30 days and remove their runners |
| `device-status-broadcaster` | WebSocket fan-out of `device.status` events |

## Related decisions

- ADR 0001 — Device-runner architecture
- ADR 0005 — Dual-principal auth
