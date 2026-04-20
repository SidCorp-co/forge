# Issues & Pipeline

The 14-status state machine that routes work through agent stages.

## Overview

A project contains issues. Each issue has a status representing where it is in the pipeline. Pipeline transitions can trigger agent skills (via jobs dispatched to paired devices); each transition is either auto-run or human-gated per-project.

## Data Flow

```
Input sources:
  - Web UI (user creates issue)
  - Webhook ingestion (external platform POSTs)
  - MCP tool call (agent creates issue)
          │
          ▼
  ┌──────────────┐
  │ issue record │
  └──────┬───────┘
         │ lifecycle hook on create / update
         ▼
  ┌──────────────┐
  │ pipeline     │ ──── auto-run enabled? ──── yes ──► enqueue job
  │ decision     │                                      (see agents-jobs)
  │ point        │                          no ──► wait for human gate
  └──────────────┘
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| title, description, priority | Web UI form | User input, direct |
| title, description | Webhook payload | Mapped from external platform's event shape |
| project | URL path / selected in UI | Scopes the issue to a project |
| status | Default `open` on create; transitions driven by pipeline | See state machine below |

### ID Resolution

| Input | Transform | Stored as |
|-------|-----------|-----------|
| Selected project in UI | Resolve to `project.documentId` | `issue.project` relation |
| `ISS-42` user-facing ID | Resolve to internal `documentId` | `issue.documentId` is canonical |

## Core Entities

### `Project`

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `slug` | URL-friendly name, unique |
| `baseBranch` | Default branch for git operations (e.g., `main`) |
| `productionBranch` | Branch for `released` issues (e.g., `production`) |
| `devices` (m2m) | Pool of devices authorized for this project |
| `activeDevice` | Currently bound device (1 at a time) |
| `agentConfig` | Per-stage toggles: `autoTriage`, `autoClarify`, `autoPlan`, etc. |
| `webhookUrl`, `webhookSecret` | Outbound webhook configuration |
| `webhookStatuses` | Which statuses trigger outbound webhook |

### `Issue`

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `issueId` | `ISS-<number>` user-facing ID |
| `title`, `description`, `priority`, `category` | User fields |
| `status` | One of 14 statuses (see status lifecycle) |
| `project` | Belongs to one project |
| `sessionContext` | JSON accumulator for agent session memory |
| `changeHistory` | Audit log of status / priority / title changes |
| `agentSessions` / `jobs` (hasMany) | All runs on this issue |

### `Comment`, `Label`, `Activity`

Standard supporting entities. See code for schema detail.

## Status Lifecycle

14 statuses + branches. See [status-pipeline.md](status-pipeline.md) for the full lifecycle reference (transition rules, allowed skills, reopen cycles, blocked transitions).

Short version:

```
draft → open → confirmed → clarified → waiting → approved →
in_progress → developed → deploying → testing → staging →
released → closed

with branches:
  reopen (max 5 cycles) → fix → back to developed
  on_hold, needs_info (manual)
```

Each transition can map to a skill (triage, clarify, plan, code, review, test, release, fix). Per-project config toggles auto-run vs human-gate.

## Key Business Flows

### Issue created via webhook → auto-triage

1. External system POSTs to `/api/webhooks/<project-slug>`
2. Server authenticates via project webhook secret
3. Issue created in status `open`
4. Lifecycle hook fires `issue:created`
5. If `autoTriage` enabled: job of type `triage` enqueued
6. See [../agents-jobs/README.md](../agents-jobs/README.md) for job execution

### Human approves a plan

1. Issue in status `clarified` with completed plan
2. User clicks "Approve" in web UI
3. Status advances to `approved`
4. If `autoCode` enabled: `forge-code` job enqueued
5. Loop continues through pipeline

### Reopen cycle

1. Issue in `testing` or later fails QA
2. User clicks "Reopen with feedback"
3. Status transitions to `reopen`, comment captures rejection reason
4. `forge-fix` job enqueued with feedback payload
5. On fix success, status → `developed`, pipeline resumes
6. Max 5 reopen cycles; beyond that, issue is `on_hold` for human review

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/issues` | Create issue (user principal) |
| `POST` | `/api/webhooks/:project-slug` | Create issue from webhook (project secret auth) |
| `GET` | `/api/issues` | List issues (scoped by project member) |
| `GET` | `/api/issues/:id` | Get issue detail |
| `PATCH` | `/api/issues/:id` | Update issue (title, priority, status transition) |
| `POST` | `/api/issues/:id/advance` | Advance to next pipeline stage (may enqueue job) |
| `POST` | `/api/issues/:id/reopen` | Move to reopen state with feedback |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Emits to | [agents-jobs](../agents-jobs/README.md) | Job enqueue | On status transition with auto-run enabled |
| Emits to | [memory-knowledge](../memory-knowledge/README.md) | Issue description embedded | On create / update |
| Emits to | External webhook URL | Status-change event | When issue reaches a status in `webhookStatuses` |
| Receives from | [agents-jobs](../agents-jobs/README.md) | Status transition | On job `complete` that advances the pipeline |
| Reads from | [devices](../devices/README.md) | `project.activeDevice` | Before enqueueing a job — must have an active device |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `stale-detector` (cron) | Every hour, flags jobs that have been `running` >30 min with no events |
| `reopen-limit-check` | Part of transition logic — blocks reopen >5 cycles |

## Documentation

| Document | Description |
|----------|-------------|
| [status-pipeline.md](status-pipeline.md) | Full 14-status lifecycle reference — transition rules, skill mappings, gate semantics |
