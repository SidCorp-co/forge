# Issues & Pipeline

The 17-status state machine that routes work through agent stages.

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
| `status` | One of 17 statuses (see status lifecycle) |
| `project` | Belongs to one project |
| `sessionContext` | JSON accumulator for agent session memory |
| `changeHistory` | Audit log of status / priority / title changes |
| `agentSessions` / `jobs` (hasMany) | All runs on this issue |

### `Comment`, `Label`, `Activity`

Standard supporting entities. See code for schema detail.

## Status Lifecycle

17 statuses + branches. Full reference (transition rules, allowed skills, reopen cycles, blocked transitions): [status-pipeline.md](status-pipeline.md).

```
draft → open → confirmed → waiting → approved →
in_progress → developed → deploying → testing → tested → pass →
staging → released → closed

with branches:
  reopen (max 5 cycles) → fix → back to developed
  on_hold, needs_info (manual)
```

Each transition can map to a skill (triage, clarify, plan, code, review, test, release, fix). Per-project config toggles auto-run vs human-gate.

## Key Business Flows

- **Webhook → auto-triage**: external POST to `/api/webhooks/in/:slug` → auth via project webhook secret → issue created `open` → lifecycle hook fires `issue:created` → if `autoTriage`, `triage` job enqueued (execution: [../agents-jobs/README.md](../agents-jobs/README.md)).
- **Human approves plan**: issue `waiting` with completed plan → user clicks "Approve" → status → `approved` → if `autoCode`, `forge-code` job enqueued → loop continues.
- **Reopen cycle**: issue `testing`+ fails QA → user clicks "Reopen with feedback" → status → `reopen`, comment captures rejection reason → `forge-fix` job enqueued with feedback payload → on success status → `developed`, pipeline resumes. Max 5 reopen cycles; beyond → `on_hold` for human review.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/projects/:id/issues` | Create issue (user principal) |
| `POST` | `/api/webhooks/in/:slug` | Create issue from webhook (project secret auth) |
| `GET` | `/api/projects/:id/issues` | List issues (scoped by project member) |
| `GET` | `/api/issues/:id` | Get issue detail |
| `PATCH` | `/api/issues/:id` | Update issue (title, priority, status transition) |
| `POST` | `/api/issues/:id/transition` | Transition issue to a target pipeline status (enforces state machine + reopen cap) |

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
| `stale-job-detector` (cron) | Every 5 minutes (`*/5 * * * *`), flags jobs stuck `running` with no recent events |
| `reopen-limit-check` | Part of transition logic — blocks reopen >5 cycles |

## Documentation

| Document | Description |
|----------|-------------|
| [status-pipeline.md](status-pipeline.md) | Full 17-status lifecycle reference — transition rules, skill mappings, gate semantics |
| [decompose.md](decompose.md) | Epic → children decomposition lifecycle — create/approve cascade, children-first + parent-last gating |
