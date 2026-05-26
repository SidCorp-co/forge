# Agents & Jobs

Job queue, dispatch, execution, and event streaming. The execution orchestration layer between the pipeline and the devices.

## Overview

A **Job** is a unit of agent work: "run `forge-plan` on ISS-42 for project `forge-agents`." Jobs are enqueued by the pipeline, dispatched to the project's active device, executed as a `claude` CLI invocation on that device, and streamed back as **JobEvents**.

## Data Flow

```
  [issues-pipeline] status transition
          │
          ▼
  ┌────────────────────┐
  │ Job.insert         │ status=queued
  │ (pg-boss enqueue)  │
  └────────┬───────────┘
           │ dispatcher polls
           ▼
  ┌────────────────────┐
  │ Lookup              │
  │ project.activeDevice│
  └────────┬───────────┘
           │ WS push
           ▼
  ┌────────────────────┐
  │ Device agent        │ (on paired machine)
  │ spawns `claude` CLI │
  └────────┬───────────┘
           │ stdout/stderr/tool-calls
           ▼
  ┌────────────────────┐     batched POST
  │ JobEvent stream     │ ────────────────► server
  └────────┬───────────┘                     │
           │ WS broadcast to project room   │
           ▼                                ▼
     Web dashboard renders live      JobEvent persisted
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| Job enqueue | `issues-pipeline` lifecycle hook | Derived from status transition + `agentConfig` |
| Job payload | Built by the pipeline from issue + skill name | Includes `{ projectSlug, issueId, skillName, args }` |
| JobEvent batches | Device agent | Claude CLI output, batched every 500ms or 32 events |
| Job completion | Device agent | POST `/api/jobs/:id/complete` with exit code + summary |

### Stored entities

| Entity | Key fields |
|--------|-----------|
| `Job` | `project`, `issue`, `device`, `type`, `payload`, `status`, `queuedAt`, `dispatchedAt`, `startedAt`, `finishedAt`, `exitCode`, `error` |
| `JobEvent` | `job`, `ts`, `kind` (stdout/stderr/tool-call/tool-result/progress/result), `data`, `seq` (monotonic) |

## Core Entities

### `Job`

Status flow:

```
queued → dispatched → running → done / failed / cancelled
```

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `project` | Belongs to one project |
| `issue` | Optional — the issue this job serves |
| `device` | Set on dispatch; null while queued |
| `createdBy` | User who enqueued (or `system` for auto-triggered) |
| `type` | `triage` \| `clarify` \| `plan` \| `code` \| `review` \| `test` \| `release` \| `fix` \| `custom` |
| `payload` | `{ skillName, args, ... }` |
| `status` | See flow above |
| `queuedAt` / `dispatchedAt` / `startedAt` / `finishedAt` | Lifecycle timestamps |
| `exitCode`, `error` | On done / failed |

### `JobEvent`

Append-only event log per job. `seq` is monotonic per job — the dashboard uses it for ordered rendering and reconnect replay.

Retention: **30 days after the parent Job reaches a terminal state.** Daily cron sweeps expired events.

## Key Business Flows

### Enqueue → dispatch → execute → complete

1. Pipeline enqueues job: `Job.create({ status: 'queued', ...payload })`
2. pg-boss publishes to queue
3. Dispatcher polls, looks up `project.activeDevice`
4. If device online: `Job.update({ status: 'dispatched', device })` + WS `job.assigned` to device room
5. If device offline: job stays `queued`, UI shows "Waiting for device `macbook-pro`"
6. Device receives, spawns `claude`, transitions job: `Job.update({ status: 'running' })`
7. Device POSTs JobEvent batches to `/api/jobs/:id/events`
8. Server persists, broadcasts on project WS room
9. Device POSTs `/api/jobs/:id/complete` with exit code
10. `Job.update({ status: 'done' / 'failed', finishedAt })`
11. Pipeline decides if next stage auto-triggers

### Cancel a running job

1. User clicks "Cancel" in UI → `POST /api/jobs/:id/cancel` (user principal)
2. Server marks `cancellationRequested = true`
3. Server WS pushes `job.cancel` to device room
4. Device receives, sends SIGTERM to Claude subprocess
5. Device POSTs `/complete` with `exitCode: -1`, `error: 'cancelled'`
6. `Job.update({ status: 'cancelled' })`

### Stale detection + auto-retry

1. Cron every 5 min: find jobs `running` with no JobEvent in 5+ min
2. Assume stuck; mark `Job.update({ status: 'failed', error: 'stale' })`
3. If retry count <3: re-enqueue new job with same payload
4. Beyond 3 retries: leave as failed, surface in health dashboard

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/projects/:id/jobs` | user | Enqueue |
| `GET` | `/api/jobs/:id` | user / device | Read (policy-scoped) |
| `GET` | `/api/jobs/:id/events?since=:seq` | user | Paginated replay |
| `POST` | `/api/jobs/:id/cancel` | user | Request cancellation |
| `POST` | `/api/jobs/:id/events` | device | Submit JobEvent batch |
| `POST` | `/api/jobs/:id/complete` | device | Report completion |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Receives from | [issues-pipeline](../issues-pipeline/README.md) | Job enqueue request | On status transition with auto-run |
| Emits to | [issues-pipeline](../issues-pipeline/README.md) | Status-advance signal | On Job `done` |
| Emits to | [devices](../devices/README.md) | `job.assigned` WS event | On dispatch |
| Receives from | [devices](../devices/README.md) | JobEvent batches | During execution |
| Reads from | [skills](../skills/README.md) | Skill definition (prompt, tool allow-list) | At dispatch time to build payload |
| Writes to | [memory-knowledge](../memory-knowledge/README.md) | Session context, tool-call history | On completion for semantic search |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `job-dispatcher` (long-running) | Polls pg-boss queue, picks active device, dispatches |
| `stale-job-detector` (cron 5m) | Finds stuck jobs, fails them, optionally retries |
| `job-event-sweeper` (cron daily) | Deletes JobEvents older than 30 days past parent terminal |
| `job-usage-aggregator` (cron hourly) | Aggregates token usage by project / device for billing / quota dashboards |

## Related decisions

- ADR 0001 — Device-runner architecture
- ADR 0006 — pg-boss for job queue
