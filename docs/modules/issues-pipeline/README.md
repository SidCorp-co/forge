# Issues & Pipeline

The 16-status state machine that routes work through agent stages.

- Project contains issues; each issue's status = where it is in the pipeline.
- Transitions can trigger agent skills (jobs dispatched to paired devices); each is auto-run or human-gated per-project.

## Data Flow

Input sources → `issue record` → lifecycle hook on create/update → `pipeline decision point`: auto-run enabled? yes → enqueue job (see agents-jobs); no → wait for human gate.

Input sources: Web UI (user creates issue) · Webhook ingestion (external platform POSTs) · MCP tool call (agent creates issue).

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
| `defaultDeviceId` | Default device bound for this project's jobs |
| `agentConfig` | Per-stage config nested under `agentConfig.pipelineConfig.states[<status>]` (auto-run vs human-gate per status) |
| `webhookSecret` | Shared secret authenticating inbound webhook POSTs |

### `Issue`

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `issueId` | `ISS-<number>` user-facing ID |
| `title`, `description`, `priority`, `category` | User fields |
| `status` | One of 16 statuses (see status lifecycle) |
| `project` | Belongs to one project |
| `sessionContext` | JSON accumulator for agent session memory |
| `changeHistory` | Audit log of status / priority / title changes |
| `agentSessions` / `jobs` (hasMany) | All runs on this issue |

### `Comment`, `Label`, `Activity`

Standard supporting entities. See code for schema detail.

## Status Lifecycle

16 statuses + branches. Full reference (transition rules, allowed skills, reopen cycles, blocked transitions): [status-pipeline.md](status-pipeline.md).

```
draft → open → confirmed → clarified → waiting → approved →
in_progress → developed → testing → tested → released → closed

with branches:
  reopen → fix → back to developed        (no cap — RFC 0002 INV-8)
  on_hold, needs_info (manual)
  dropped                                 (discard, does NOT stamp merged_at)
```

`forge-test` sets `tested` once its merge + live-verify gate passes; `tested` is the single production approval GATE (`mode:'manual'` by default), where a human advances `tested → released` and forge-release closes the issue. (`pass`/`staging` were removed from the lifecycle — unify gate model.) Each transition can map to a skill (triage, clarify, plan, code, review, test, release, fix). Per-project config toggles auto-run vs human-gate.

## Key Business Flows

- **Webhook → auto-triage**: external POST to `/api/webhooks/in/:slug` → auth via project webhook secret → issue created `open` → lifecycle hook fires `issue:created` → if `autoTriage`, `triage` job enqueued (execution: [../agents-jobs/README.md](../agents-jobs/README.md)).
- **Human approves plan**: issue `waiting` with completed plan → user clicks "Approve" → status → `approved` → if `autoCode`, `forge-code` job enqueued → loop continues.
- **Reopen cycle**: issue `testing`+ fails QA → status → `reopen` carrying a **required** `reason` (posted as a comment before the flip; 422 `REOPEN_REASON_REQUIRED` without it) → `forge-fix` job enqueued → on success status → `developed`, pipeline resumes. There is no cap: RFC 0002 replaced it with the required reason plus an advisory `noProgressRounds` alert, because a counter cannot distinguish five rounds that each fixed a different blocker from five that changed nothing ([reopen-loop-guard.md](../../architecture/reopen-loop-guard.md) is superseded on that point).

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/projects/:id/issues` | Create issue (user principal) |
| `POST` | `/api/webhooks/in/:slug` | Create issue from webhook (project secret auth) |
| `GET` | `/api/projects/:id/issues` | List issues (scoped by project member) |
| `GET` | `/api/issues/:id` | Get issue detail |
| `PATCH` | `/api/issues/:id` | Update issue (title, priority, status transition) |
| `POST` | `/api/issues/:id/transition` | Transition issue to a target pipeline status (enforces the state machine; there is no reopen cap) |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Emits to | [agents-jobs](../agents-jobs/README.md) | Job enqueue | On status transition with auto-run enabled |
| Emits to | [memory-knowledge](../memory-knowledge/README.md) | Issue description embedded | On create / update |
| Receives from | [agents-jobs](../agents-jobs/README.md) | Status transition | On job `complete` that advances the pipeline |
| Reads from | [devices](../devices/README.md) | `project.defaultDeviceId` | Before enqueueing a job — resolves the bound device |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `stale-job-detector` (cron) | **Alarm-only** — it reports jobs stuck in `dispatched`/`running` past a 60-minute threshold (bumped 5→60 min per ISS-258 — legit merges run >5 min between events); it does not reap. The primary reaper is `runLoopMonitor` (`jobs/loop-monitor.ts`). `reconcileOrphanedJobs` no longer exists — its ISS-280 semantics moved to `reapSessionLostJobs` |

## Documentation

| Document | Description |
|----------|-------------|
| [status-pipeline.md](status-pipeline.md) | Full 15-status lifecycle reference — transition rules, skill mappings, gate semantics |
| [decompose.md](decompose.md) | Epic → children decomposition lifecycle — create/approve cascade, children-first + parent-last gating |
| [release-gate.md](release-gate.md) | The release gate that closes the autonomous pipeline — `awaiting_release`, the batch release path, deploy channels and the verify probe. As-built; the design record six `core`/`contracts` modules cite |
