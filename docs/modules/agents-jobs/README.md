# Agents & Jobs

Execution orchestration between the pipeline and devices: job queue, dispatch, execution, event streaming.

> Sub-docs: [prompt-config.md](prompt-config.md) — SSOT system-prompt builder + per-state model/tools/mcp config + prompt hashing · [skill-facts.md](skill-facts.md) — versioned facts registry injected into the system prompt so skills stay business-logic-only.

## Overview

A **Job** = a unit of agent work (e.g. "run `forge-plan` on ISS-42 for project `forge-agents`"). Enqueued by the pipeline → dispatched to the project's active device → executed as a `claude` CLI invocation there → streamed back as **JobEvents**.

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
| `type` | `triage` \| `clarify` \| `plan` \| `code` \| `review` \| `test` \| `release` \| `fix` \| `custom` \| `pm` \| `smoke` — `smoke` is the issue-less smoke-verify canary (tier-2, one-shot on a `system` pipeline_run; PASS/FAIL = the job's terminal status) |
| `payload` | `{ skillName, args, ... }` |
| `status` | See flow above |
| `queuedAt` / `dispatchedAt` / `startedAt` / `finishedAt` | Lifecycle timestamps |
| `exitCode`, `error` | On done / failed |

### `JobEvent`

- Append-only event log per job. `seq` monotonic per job — dashboard uses it for ordered rendering and reconnect replay.
- Retention: **30 days after the parent Job reaches a terminal state.** Daily cron sweeps expired events.

## Key Business Flows

### Enqueue → dispatch → execute → complete

1. Pipeline enqueues: `Job.create({ status: 'queued', ...payload })`
2. pg-boss publishes to queue
3. Dispatcher polls, looks up `project.activeDevice`
4. Device online: `Job.update({ status: 'dispatched', device })` + WS `job.assigned` to device room
5. Device offline: job stays `queued`, UI shows "Waiting for device `macbook-pro`"
6. Device receives, spawns `claude`, `Job.update({ status: 'running' })`
7. Device POSTs JobEvent batches to `/api/jobs/:id/events`
8. Server persists, broadcasts on project WS room
9. Device POSTs `/api/jobs/:id/complete` with exit code
10. `Job.update({ status: 'done' / 'failed', finishedAt })`
11. Pipeline decides if next stage auto-triggers

### Cancel a running job

1. User clicks "Cancel" → `POST /api/jobs/:id/cancel` (user principal), **or** an operator calls the `forge_jobs.cancel` MCP tool (audited manual single-job cancel escape hatch). Both share the same `jobs/cancel-job.ts` logic.
2. Server marks `cancellationRequested = true`
3. Server WS pushes `job.cancel` to device room
4. Device sends SIGTERM to Claude subprocess
5. Device POSTs `/complete` with `exitCode: -1`, `error: 'cancelled'`
6. `Job.update({ status: 'cancelled' })`

### Stale detection (closed loop) + auto-retry

**Reaper — the closed job loop (`jobs/loop-monitor.ts`, `runLoopMonitor`).** This is the PRIMARY reaper for every non-progressing job/session state. It runs as the FIRST pass of the per-minute pipeline-sweeper tick (`pipeline/sweeper.ts`, `runPipelineSweep`). It models the lifecycle as a four-hop closed loop, each hop with one timeout and exactly one miss-handler (all terminal writes via `applyKernelTransition`, all reaps routed through the shared `finalizeFailedJob` tail):

1. **dispatch→ack** — a `dispatched` job never acked with zero events past the ack grace → fail `dispatch_unclaimed`.
2. **ack→heartbeat (claim)** — a pipeline/pm session sitting `queued` past the queue timeout → fail `queue_timeout`.
3. **heartbeat** — a `running` session with a stale heartbeat → `heartbeat_timeout`; a chat/schedule session that never attached a client → `no_client_ack`; a job whose linked session is terminal with no `result` event → `session_lost`.
4. **result** — a claimed job that emitted no event for `RESULT_QUIET_MINUTES` (= **60**, bumped 5→60 per ISS-258 because legit merges run >5 min between events) and never a `result` → fail `stale`.

The legacy sweepers are DEMOTED to alarm-only (`alarmZombieSessions`, `alarmOrphanedJobs`, `alarmNeverClaimedDispatches`): they keep their detection SELECTs but perform NO terminal writes — running right after the loop in the same tick, any row they still match is a loop MISS, logged `loop-miss` + surfaced as a `pipeline_wedge`.

**Auto-retry — device-rotation (`jobs/retry.ts`).** A reaped/failed job is rescheduled via bounded round-robin across online devices, NOT a flat `<3` threshold:

- `RETRY_TRIES_PER_DEVICE` = **3** attempts per device before the chain rotates to the next online device.
- `RETRY_MAX_ROUNDS` = **10** full device sweeps; beyond that the chain stops and the caller parks the issue at `waiting` for a human.
- `RETRY_COOLDOWN_MS` = **60s** between attempts.

(Rotation state lives in `payload._autoRetry`; the classifier verdict drives per-class policy — `code` never retries, `transient-cc` does immediate different-device failover.)

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/projects/:id/jobs` | user | Enqueue |
| `GET` | `/api/jobs/:id` | user / device | Read (policy-scoped) |
| `GET` | `/api/jobs/:id/events?since=:seq` | user | Paginated replay |
| `POST` | `/api/jobs/:id/cancel` | user | Request cancellation |
| MCP | `forge_jobs.cancel` | operator | Audited manual single-job cancel escape hatch (same `jobs/cancel-job.ts` logic as the REST route) |
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
| `pipeline-sweeper` (cron, ~1-min tick) | Runs `runLoopMonitor` (`jobs/loop-monitor.ts`) FIRST as the primary closed-loop reaper (dispatch→ack→heartbeat→result; result hop `RESULT_QUIET_MINUTES` = 60), then the demoted alarm-only passes (`alarmZombieSessions`, `alarmOrphanedJobs`, `alarmNeverClaimedDispatches` — detection SELECTs, no terminal writes). Reaped jobs route through device-rotation auto-retry (`jobs/retry.ts`) |
| `job-event-sweeper` (cron daily) | Deletes JobEvents older than 30 days past parent terminal |
| `job-usage-aggregator` (cron hourly) | Aggregates token usage by project / device for billing / quota dashboards |

## Related decisions

- ADR 0001 — Device-runner architecture
- ADR 0006 — pg-boss for job queue
