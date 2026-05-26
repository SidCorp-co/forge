# Devices

Paired machines that run `claude` CLI locally. The runtime plane's connection point to the control plane.

## Overview

A user pairs devices (laptop, desktop, CI box) with their account. Each device installs the Forge agent (Tauri `dev` or `forged` CLI). Projects bind to devices from a user's pool — one active at a time per project.

## Data Flow

```
  User clicks "Add device" in web UI
        │
        ▼
  Server generates pairing code (5-min TTL)
        │
        ▼ displayed to user
  User runs `forged pair F9-3K7T-92XA` on machine
        │
        ▼
  POST /api/devices/pair { code, name, platform, capabilities }
        │
        ▼
  Server validates code, issues device token (argon2-hashed in DB)
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
    - project:<id> for every project with device in pool
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| pairing code | User UI click | Short-lived, one-time-use, project-agnostic |
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

1. User navigates **Account → Devices → Add device**
2. `POST /api/devices/pairing-codes` → returns 8-char code
3. Code displayed in web UI
4. User runs `forged pair F9-3K7T-92XA` on machine
5. Agent POSTs `{ code, name, platform, capabilities }` → receives device token
6. Agent stores token in OS keychain, opens WS
7. Device appears online in web UI

### Project binding

1. User navigates **Project → Settings → Runtime**
2. Dropdown shows user's devices (by `name`, showing `status`)
3. User picks a device → `PUT /api/projects/:id/runtime/active-device`
4. Server validates:
   - Is the user a project member?
   - Is the device in the project's pool (or adds it first)?
   - Are there any `running` jobs? If yes → 409 with `jobId` (user must cancel or wait)
5. Server updates `project.activeDevice`
6. On first bind, UI prompts for repo local path → device clones if needed

### Heartbeat + online / offline detection

1. Device sends `POST /api/devices/heartbeat` every 30s
2. Server updates `lastSeenAt`
3. Cron every 2 min: marks devices with `lastSeenAt > 90s ago` as `offline`
4. On next heartbeat: `status → online`

### Revocation

1. User clicks **Revoke** on device card
2. `DELETE /api/devices/:id`
3. Server sets `status = revoked`, invalidates `tokenHash`
4. Server closes the device's WebSocket
5. Any `running` jobs on this device get `cancelled` with reason `device_revoked`
6. Next reconnect attempt: 401, device surfaces "Device revoked, please re-pair"

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/devices/pairing-codes` | user | Generate pairing code |
| `POST` | `/api/devices/pair` | public | Device redeems pairing code |
| `GET` | `/api/devices` | user | List user's devices |
| `DELETE` | `/api/devices/:id` | user | Revoke |
| `POST` | `/api/devices/heartbeat` | device | Update `lastSeenAt` |
| `PUT` | `/api/projects/:id/runtime/active-device` | user | Bind project to device |
| `POST` | `/api/projects/:id/devices` | user | Add device to project pool |
| `DELETE` | `/api/projects/:id/devices/:deviceId` | user | Remove from pool |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Emits to | [agents-jobs](../agents-jobs/README.md) | WebSocket `job.accept` | On receiving `job.assigned` |
| Emits to | [agents-jobs](../agents-jobs/README.md) | JobEvent batches | During execution |
| Receives from | [agents-jobs](../agents-jobs/README.md) | WebSocket `job.assigned`, `job.cancel` | On dispatch / cancellation |
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Project binding request | User sets `activeDevice` |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `pairing-code-sweeper` (cron 1m) | Delete expired pairing codes |
| `device-status-detector` (cron 2m) | Mark offline devices whose heartbeat has lapsed |
| `device-status-broadcaster` | WebSocket fan-out of `device.status` events |

## Related decisions

- ADR 0001 — Device-runner architecture
- ADR 0005 — Dual-principal auth
