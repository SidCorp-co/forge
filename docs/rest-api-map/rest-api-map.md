# Forge REST API Usage Map

_Generated 2026-05-30T04:52:45.549Z_

## Overview

- **web** (`packages/web/src`, ts): 188 call sites
- **dev** (`packages/dev/src`, ts): 34 call sites
- **runner** (`packages/runner/crates`, rust): 17 call sites
- **Core routes defined:** 259 (259 distinct endpoints)
- **Orphan endpoints (no client calls):** 76
- **Phantom calls (no matching route):** 2

## 🪦 Orphan endpoints — defined in core, called by no scanned client

Candidates for dead code. Confirm they aren't hit by the Rust runner, MCP tools, an
external integration, or a webhook before removing.

- `POST /api/admin/pipeline/clear-hold/:issueId` — `packages/core/src/admin/pipeline-health-routes.ts:81`
- `GET /api/admin/pipeline/health` — `packages/core/src/admin/pipeline-health-routes.ts:37`
- `POST /api/agent-sessions` — `packages/core/src/agent-sessions/routes.ts:1167`
- `GET /api/agent-sessions/:id/pipeline-control` — `packages/core/src/agent-sessions/routes.ts:1420`
- `POST /api/agent-sessions/:id/pipeline-control` — `packages/core/src/agent-sessions/routes.ts:1447`
- `GET /api/agent-sessions/:id/pipeline-health` — `packages/core/src/agent-sessions/routes.ts:1509`
- `POST /api/agent-sessions/:id/pipeline-health` — `packages/core/src/agent-sessions/routes.ts:1539`
- `GET /api/agent-sessions/:id/pipeline-telemetry` — `packages/core/src/agent-sessions/routes.ts:1576`
- `POST /api/agent-sessions/:id/pipeline-telemetry` — `packages/core/src/agent-sessions/routes.ts:1603`
- `POST /api/agent-sessions/desktop/status` — `packages/core/src/agent-sessions/routes.ts:1007`
- `GET /api/attachments/:id/download` — `packages/core/src/issues/attachment-routes.ts:136`
- `POST /api/auth/desktop/approve` — `packages/core/src/auth/desktop/pairing-routes.ts:224`
- `POST /api/auth/desktop/pair-init` — `packages/core/src/auth/desktop/pairing-routes.ts:125`
- `GET /api/auth/desktop/poll` — `packages/core/src/auth/desktop/pairing-routes.ts:298`
- `POST /api/auth/dev/force-verify` — `packages/core/src/auth/dev-force-verify.ts:13`
- `GET /api/auth/oauth/:provider/callback` — `packages/core/src/auth/oauth/routes.ts:45`
- `GET /api/auth/oauth/:provider/reauth-start` — `packages/core/src/auth/oauth/routes.ts:58`
- `GET /api/auth/oauth/:provider/start` — `packages/core/src/auth/oauth/routes.ts:36`
- `GET /api/auth/verify` — `packages/core/src/auth/verify.ts:31`
- `POST /api/auth/verify` — `packages/core/src/auth/verify.ts:39`
- `POST /api/chat` — `packages/core/src/chat/routes.ts:47`
- `GET /api/chat-logs/flagged` — `packages/core/src/chat-logs/routes.ts:179`
- `GET /api/chat-logs/recent` — `packages/core/src/chat-logs/routes.ts:152`
- `GET /api/chat/sessions` — `packages/core/src/chat/sessions-routes.ts:59`
- `POST /api/chat/sessions` — `packages/core/src/chat/sessions-routes.ts:88`
- `DELETE /api/chat/sessions/:id` — `packages/core/src/chat/sessions-routes.ts:172`
- `GET /api/chat/sessions/:id` — `packages/core/src/chat/sessions-routes.ts:117`
- `PATCH /api/chat/sessions/:id` — `packages/core/src/chat/sessions-routes.ts:137`
- `GET /api/comments/:id/replies` — `packages/core/src/comments/routes.ts:237`
- `GET /api/comments/attachments/:id` — `packages/core/src/comments/upload.ts:105`
- `GET /api/domain-templates` — `packages/core/src/domain-templates/routes.ts:37`
- `GET /api/domain-templates/:key` — `packages/core/src/domain-templates/routes.ts:42`
- `POST /api/domain-templates/apply` — `packages/core/src/domain-templates/routes.ts:59`
- `GET /api/invitations/:token` — `packages/core/src/projects/invitations-routes.ts:20`
- `POST /api/invitations/:token/accept` — `packages/core/src/projects/invitations-routes.ts:58`
- `DELETE /api/issue-step-contexts` — `packages/core/src/pipeline/step-handoff-routes.ts:92`
- `GET /api/issue-step-contexts` — `packages/core/src/pipeline/step-handoff-routes.ts:70`
- `POST /api/issue-step-contexts` — `packages/core/src/pipeline/step-handoff-routes.ts:56`
- `PATCH /api/jobs/:id` — `packages/core/src/jobs/routes.ts:247`
- `POST /api/jobs/:id/events` — `packages/core/src/jobs/events-routes.ts:98`
- `POST /api/memory` — `packages/core/src/memory/write-routes.ts:16`
- `DELETE /api/memory/by-source` — `packages/core/src/memory/list-routes.ts:54`
- `GET /api/projects/:id/activity` — `packages/core/src/issues/activity-routes.ts:198`
- `GET /api/projects/:id/analytics/cost-summary` — `packages/core/src/pipeline/analytics-routes.ts:285`
- `GET /api/projects/:id/analytics/cost-trend` — `packages/core/src/pipeline/analytics-routes.ts:356`
- `GET /api/projects/:id/analytics/outliers` — `packages/core/src/pipeline/analytics-routes.ts:415`
- `POST /api/projects/:id/api-key/rotate` — `packages/core/src/projects/routes.ts:285`
- `GET /api/projects/:id/issues/:issueId/branch-config` — `packages/core/src/projects/routes.ts:715`
- `POST /api/projects/:id/skills/bootstrap` — `packages/core/src/projects/routes.ts:793`
- `PATCH /api/projects/:projectId/members/:userId` — `packages/core/src/projects/members-routes.ts:175`
- `POST /api/projects/:projectId/pm/run` — `packages/core/src/pm/routes.ts:131`
- `GET /api/projects/:projectId/skills/:skillId/override` — `packages/core/src/skills/override-routes.ts:155`
- `POST /api/projects/:projectId/skills/sync` — `packages/core/src/skills/routes.ts:100`
- `POST /api/prompts/preview` — `packages/core/src/prompt/routes.ts:60`
- `GET /api/runners` — `packages/core/src/runners/routes.ts:108`
- `POST /api/runners` — `packages/core/src/runners/routes.ts:153`
- `DELETE /api/runners/:id` — `packages/core/src/runners/routes.ts:244`
- `GET /api/runners/:id` — `packages/core/src/runners/routes.ts:137`
- `PATCH /api/runners/:id` — `packages/core/src/runners/routes.ts:196`
- `POST /api/runners/:id/events` — `packages/core/src/runners/routes.ts:400`
- `POST /api/runners/:id/exclude` — `packages/core/src/runners/routes.ts:318`
- `POST /api/runners/:id/health-check` — `packages/core/src/runners/routes.ts:267`
- `POST /api/runners/:id/include` — `packages/core/src/runners/routes.ts:335`
- `POST /api/runners/:id/refresh-quota` — `packages/core/src/runners/routes.ts:286`
- `GET /api/runners/types` — `packages/core/src/runners/routes.ts:97`
- `PUT /api/uploads/:uploadId` — `packages/core/src/uploads/routes.ts:41`
- `GET /api/usage-records/:id` — `packages/core/src/usage-records/routes.ts:189`
- `POST /api/usage-records/bulk` — `packages/core/src/usage-records/routes.ts:256`
- `POST /api/webhooks/in/:slug` — `packages/core/src/webhooks/inbound-routes.ts:37`
- `GET /health` — `packages/core/src/index.ts:undefined`
- `GET /install.sh` — `packages/core/src/install/routes.ts:59`
- `GET /install/bin/:target` — `packages/core/src/install/routes.ts:88`
- `GET /install/latest.json` — `packages/core/src/install/routes.ts:65`
- `DELETE /mcp` — `packages/core/src/index.ts:undefined`
- `GET /mcp` — `packages/core/src/index.ts:undefined`
- `POST /mcp` — `packages/core/src/index.ts:undefined`

## 👻 Phantom calls — client hits a path with no matching core route

Likely a typo, a stale endpoint, a dynamically-built path, or a route handled elsewhere
(static mount, proxy). Verify each.

- `POST /api/agent-sessions/trigger-pipeline` — web `packages/web/src/features/agent/api.ts:343`
- `POST /api/projects/${projectId}/members` — web `packages/web/src/features/project/api/project-api.ts:71` _(dynamic path)_

## ⚖️ Client coverage

Endpoints reached by exactly one client. Expected for client-specific surfaces (e.g.
device/runner endpoints); a flag only when you'd expect parity.

### only `web` (144)
- `GET /api/admin/audit`
- `GET /api/admin/devices`
- `GET /api/admin/projects`
- `GET /api/admin/users`
- `GET /api/admin/whoami`
- `GET /api/agent-sessions`
- `DELETE /api/agent-sessions/:id`
- `GET /api/agent-sessions/:id`
- `POST /api/agent-sessions/:id/cancel`
- `POST /api/agent-sessions/:id/fork`
- `POST /api/agent-sessions/:id/rerun`
- `POST /api/agent-sessions/:id/retry`
- `GET /api/agent-sessions/:id/turns`
- `PATCH /api/agent-sessions/:id/turns/:turnId`
- `POST /api/agent-sessions/:id/turns/:turnId/regenerate`
- `POST /api/agent-sessions/abort`
- `POST /api/agent-sessions/build-prompt`
- `GET /api/agent-sessions/desktop/status`
- `GET /api/agent-sessions/queue-stats`
- `POST /api/agent-sessions/sweep-zombies`
- `POST /api/agents`
- `DELETE /api/agents/:id`
- `GET /api/agents/:id`
- `GET /api/app-config/:projectId`
- `PUT /api/app-config/:projectId`
- `DELETE /api/attachments/:id`
- `POST /api/auth/local`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/me/preferences`
- `PATCH /api/auth/me/preferences`
- `GET /api/auth/oauth/providers`
- `GET /api/auth/preferences`
- `PATCH /api/auth/preferences`
- `POST /api/auth/reauth`
- `POST /api/auth/refresh`
- `POST /api/auth/register`
- `GET /api/chat-logs`
- `GET /api/chat-logs/:id`
- `PATCH /api/chat-logs/:id`
- `POST /api/comments/:commentId/attachments`
- `PATCH /api/devices/:id`
- `GET /api/devices/:id/runners`
- `DELETE /api/issues/:id`
- `GET /api/issues/:id/activity`
- `DELETE /api/issues/:id/activity/:activityId`
- `PATCH /api/issues/:id/activity/:activityId/evaluate`
- `GET /api/issues/:id/attachments`
- `POST /api/issues/:id/attachments`
- `POST /api/issues/:id/decompose`
- `GET /api/issues/:id/dependencies`
- `POST /api/issues/:id/dependencies`
- `DELETE /api/issues/:id/dependencies/:edgeId`
- `GET /api/issues/:id/job-history`
- `PATCH /api/issues/:id/manual-hold`
- `POST /api/issues/:id/run-pipeline-step`
- `POST /api/issues/:id/tasks`
- `POST /api/issues/:id/tasks/reorder`
- `PATCH /api/issues/batch`
- `GET /api/issues/pipeline-timing`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/cancel`
- `GET /api/jobs/:id/prompt`
- `GET /api/knowledge-edges`
- `POST /api/knowledge-edges`
- `DELETE /api/knowledge-edges/:id`
- `POST /api/knowledge/ingest`
- `DELETE /api/labels/:id`
- `PATCH /api/labels/:id`
- `GET /api/me/attention`
- `GET /api/me/devices`
- `GET /api/memory`
- `DELETE /api/memory/:id`
- `POST /api/memory/search`
- `DELETE /api/notifications/:id`
- `GET /api/pat`
- `POST /api/pat`
- `DELETE /api/pat/:id`
- `GET /api/pat/:id/audit`
- `POST /api/pat/:id/rotate`
- `GET /api/pipeline-runs/:id`
- `POST /api/pipeline-runs/:id/cancel`
- `POST /api/pipeline-runs/:id/pause`
- `POST /api/pipeline-runs/:id/resume`
- `GET /api/pipeline/cycle-time`
- `GET /api/pipeline/registry`
- `GET /api/pipeline/step-durations`
- `GET /api/pipeline/throughput`
- `POST /api/projects`
- `DELETE /api/projects/:id`
- `POST /api/projects/:id/devices/pairing-codes`
- `GET /api/projects/:id/issues/by-display/:displayId`
- `GET /api/projects/:id/issues/search`
- `GET /api/projects/:id/jobs`
- `POST /api/projects/:id/jobs`
- `GET /api/projects/:id/labels`
- `POST /api/projects/:id/labels`
- `GET /api/projects/:id/pipeline-config`
- `PATCH /api/projects/:id/pipeline-config`
- `GET /api/projects/:id/pipeline-runs`
- `POST /api/projects/:id/runners`
- `DELETE /api/projects/:id/runners/:runnerId`
- `PATCH /api/projects/:id/runners/:runnerId`
- `GET /api/projects/:projectId/integrations`
- `POST /api/projects/:projectId/integrations`
- `DELETE /api/projects/:projectId/integrations/:id`
- `PATCH /api/projects/:projectId/integrations/:id`
- `POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy`
- `GET /api/projects/:projectId/integrations/:id/deliveries`
- `POST /api/projects/:projectId/integrations/:id/rotate-secret`
- `POST /api/projects/:projectId/integrations/:id/test`
- `GET /api/projects/:projectId/members`
- `DELETE /api/projects/:projectId/members/:userId`
- `POST /api/projects/:projectId/members/invite`
- `GET /api/projects/:projectId/pm/config`
- `PUT /api/projects/:projectId/pm/config`
- `GET /api/projects/:projectId/pm/decisions`
- `POST /api/projects/:projectId/pm/escalations/:decisionId/respond`
- `GET /api/projects/:projectId/pm/policies`
- `POST /api/projects/:projectId/pm/policies`
- `DELETE /api/projects/:projectId/pm/policies/:id`
- `PATCH /api/projects/:projectId/pm/policies/:id`
- `GET /api/projects/:projectId/skill-registrations`
- `DELETE /api/projects/:projectId/skills/:skillId/override`
- `PUT /api/projects/:projectId/skills/:skillId/override`
- `POST /api/projects/:projectId/skills/:skillId/register`
- `DELETE /api/projects/:projectId/skills/registrations/:stage`
- `GET /api/projects/health`
- `GET /api/schedules`
- `POST /api/schedules`
- `DELETE /api/schedules/:id`
- `GET /api/schedules/:id`
- `PUT /api/schedules/:id`
- `POST /api/schedules/:id/run`
- `GET /api/skills`
- `POST /api/skills`
- `DELETE /api/skills/:id`
- `GET /api/skills/:id`
- `PUT /api/skills/:id`
- `POST /api/skills/bulk-push`
- `POST /api/skills/sync-status`
- `DELETE /api/tasks/:taskId`
- `GET /api/tasks/:taskId`
- `GET /api/usage-records`

### only `dev` (3)
- `POST /api/agent-sessions/:id/relay`
- `POST /api/agent-sessions/prompt-built`
- `POST /api/usage-records`

### only `runner` (6)
- `POST /api/devices/heartbeat`
- `GET /api/devices/me/runners`
- `PATCH /api/devices/me/runners/:runnerId`
- `POST /api/devices/pair`
- `POST /api/jobs/:id/complete`
- `POST /api/jobs/:id/fail`

## Endpoints & callers

| Endpoint | Clients | Callers |
|---|---|---|
| `GET /api/admin/audit` | web | web:apiClientList |
| `GET /api/admin/devices` | web | web:apiClientList |
| `POST /api/admin/pipeline/clear-hold/:issueId` | — | — |
| `GET /api/admin/pipeline/health` | — | — |
| `GET /api/admin/projects` | web | web:apiClientList |
| `GET /api/admin/users` | web | web:apiClientList |
| `GET /api/admin/whoami` | web | web:apiClient |
| `GET /api/agent-sessions` | web | web:apiClient<br>web:apiClient<br>web:apiClient<br>web:apiClientList |
| `POST /api/agent-sessions` | — | — |
| `DELETE /api/agent-sessions/:id` | web | web:apiClient |
| `GET /api/agent-sessions/:id` | web | web:apiClient |
| `PATCH /api/agent-sessions/:id` | dev, web | web:apiClient<br>web:apiClient<br>web:apiClient<br>dev:request |
| `POST /api/agent-sessions/:id/cancel` | web | web:apiClient |
| `POST /api/agent-sessions/:id/fork` | web | web:apiClient |
| `GET /api/agent-sessions/:id/pipeline-control` | — | — |
| `POST /api/agent-sessions/:id/pipeline-control` | — | — |
| `GET /api/agent-sessions/:id/pipeline-health` | — | — |
| `POST /api/agent-sessions/:id/pipeline-health` | — | — |
| `GET /api/agent-sessions/:id/pipeline-telemetry` | — | — |
| `POST /api/agent-sessions/:id/pipeline-telemetry` | — | — |
| `POST /api/agent-sessions/:id/relay` | dev | dev:request |
| `POST /api/agent-sessions/:id/rerun` | web | web:apiClient |
| `POST /api/agent-sessions/:id/retry` | web | web:apiClient |
| `GET /api/agent-sessions/:id/turns` | web | web:apiClient |
| `PATCH /api/agent-sessions/:id/turns/:turnId` | web | web:apiClient |
| `POST /api/agent-sessions/:id/turns/:turnId/regenerate` | web | web:apiClient |
| `POST /api/agent-sessions/abort` | web | web:apiClient |
| `POST /api/agent-sessions/build-prompt` | web | web:apiClient |
| `GET /api/agent-sessions/desktop/status` | web | web:apiClient |
| `POST /api/agent-sessions/desktop/status` | — | — |
| `POST /api/agent-sessions/prompt-built` | dev | dev:request |
| `GET /api/agent-sessions/queue-stats` | web | web:apiClient |
| `POST /api/agent-sessions/send` | dev, web | web:apiClient<br>dev:request |
| `POST /api/agent-sessions/start` | dev, web | web:apiClient<br>web:apiClient<br>web:apiClient<br>dev:request |
| `POST /api/agent-sessions/sweep-zombies` | web | web:apiClient |
| `GET /api/agents` | dev, web | web:apiClient<br>dev:request |
| `POST /api/agents` | web | web:apiClient |
| `DELETE /api/agents/:id` | web | web:apiClient |
| `GET /api/agents/:id` | web | web:apiClient |
| `PATCH /api/agents/:id` | dev, web | web:apiClient<br>dev:request |
| `GET /api/app-config/:projectId` | web | web:apiClient |
| `PUT /api/app-config/:projectId` | web | web:apiClient |
| `DELETE /api/attachments/:id` | web | web:apiClient |
| `GET /api/attachments/:id/download` | — | — |
| `POST /api/auth/desktop/approve` | — | — |
| `POST /api/auth/desktop/pair-init` | — | — |
| `GET /api/auth/desktop/poll` | — | — |
| `POST /api/auth/dev/force-verify` | — | — |
| `POST /api/auth/local` | web | web:apiClient |
| `POST /api/auth/logout` | web | web:apiClient |
| `GET /api/auth/me` | web | web:apiClient<br>web:apiClient |
| `GET /api/auth/me/preferences` | web | web:apiClient |
| `PATCH /api/auth/me/preferences` | web | web:apiClient |
| `GET /api/auth/oauth/:provider/callback` | — | — |
| `GET /api/auth/oauth/:provider/reauth-start` | — | — |
| `GET /api/auth/oauth/:provider/start` | — | — |
| `GET /api/auth/oauth/providers` | web | web:apiClient |
| `GET /api/auth/preferences` | web | web:apiClient |
| `PATCH /api/auth/preferences` | web | web:apiClient |
| `POST /api/auth/reauth` | web | web:apiClient<br>web:apiClient |
| `POST /api/auth/refresh` | web | web:apiClient |
| `POST /api/auth/register` | web | web:apiClient |
| `GET /api/auth/verify` | — | — |
| `POST /api/auth/verify` | — | — |
| `POST /api/chat` | — | — |
| `GET /api/chat-logs` | web | web:apiClient |
| `GET /api/chat-logs/:id` | web | web:apiClient |
| `PATCH /api/chat-logs/:id` | web | web:apiClient |
| `GET /api/chat-logs/flagged` | — | — |
| `GET /api/chat-logs/recent` | — | — |
| `GET /api/chat/sessions` | — | — |
| `POST /api/chat/sessions` | — | — |
| `DELETE /api/chat/sessions/:id` | — | — |
| `GET /api/chat/sessions/:id` | — | — |
| `PATCH /api/chat/sessions/:id` | — | — |
| `POST /api/comments/:commentId/attachments` | web | web:apiMultipart |
| `DELETE /api/comments/:id` | dev, web | web:apiClient<br>dev:request |
| `PATCH /api/comments/:id` | dev, web | web:apiClient<br>dev:request |
| `GET /api/comments/:id/replies` | — | — |
| `GET /api/comments/attachments/:id` | — | — |
| `DELETE /api/devices/:id` | dev, web | web:apiClient<br>dev:request |
| `PATCH /api/devices/:id` | web | web:apiClient |
| `GET /api/devices/:id/runners` | web | web:apiClient |
| `POST /api/devices/heartbeat` | runner | runner:(literal)<br>runner:(literal)<br>runner:(literal) |
| `GET /api/devices/me/runners` | runner | runner:(literal)<br>runner:(literal)<br>runner:(literal) |
| `PATCH /api/devices/me/runners/:runnerId` | runner | runner:(literal)<br>runner:(literal) |
| `POST /api/devices/pair` | runner | runner:(literal)<br>runner:(literal)<br>runner:(literal) |
| `GET /api/domain-templates` | — | — |
| `GET /api/domain-templates/:key` | — | — |
| `POST /api/domain-templates/apply` | — | — |
| `GET /api/invitations/:token` | — | — |
| `POST /api/invitations/:token/accept` | — | — |
| `DELETE /api/issue-step-contexts` | — | — |
| `GET /api/issue-step-contexts` | — | — |
| `POST /api/issue-step-contexts` | — | — |
| `DELETE /api/issues/:id` | web | web:apiClient |
| `GET /api/issues/:id` | dev, web | web:apiClient<br>dev:request |
| `PATCH /api/issues/:id` | dev, web | web:apiClient<br>dev:request |
| `GET /api/issues/:id/activity` | web | web:apiClient |
| `DELETE /api/issues/:id/activity/:activityId` | web | web:apiClient |
| `PATCH /api/issues/:id/activity/:activityId/evaluate` | web | web:apiClient |
| `GET /api/issues/:id/attachments` | web | web:apiClient |
| `POST /api/issues/:id/attachments` | web | web:apiMultipart |
| `GET /api/issues/:id/comments` | dev, web | web:apiClient<br>web:apiClient<br>dev:request |
| `POST /api/issues/:id/comments` | dev, web | web:apiClient<br>web:apiClient<br>dev:request |
| `GET /api/issues/:id/cost-summary` | dev, web | web:apiClient<br>dev:request |
| `POST /api/issues/:id/decompose` | web | web:apiClient |
| `GET /api/issues/:id/dependencies` | web | web:apiClient |
| `POST /api/issues/:id/dependencies` | web | web:apiClient |
| `DELETE /api/issues/:id/dependencies/:edgeId` | web | web:apiClient |
| `POST /api/issues/:id/enrich` | dev, web | web:apiClient<br>dev:request |
| `GET /api/issues/:id/job-history` | web | web:apiClient |
| `PATCH /api/issues/:id/manual-hold` | web | web:apiClient |
| `POST /api/issues/:id/run-pipeline-step` | web | web:apiClient |
| `GET /api/issues/:id/tasks` | dev, web | web:apiClient<br>dev:request |
| `POST /api/issues/:id/tasks` | web | web:apiClient |
| `POST /api/issues/:id/tasks/reorder` | web | web:apiClient |
| `POST /api/issues/:id/transition` | dev, web | web:apiClient<br>dev:request |
| `PATCH /api/issues/batch` | web | web:apiClient |
| `GET /api/issues/pipeline-timing` | web | web:apiClient |
| `GET /api/jobs/:id` | web | web:apiClient |
| `PATCH /api/jobs/:id` | — | — |
| `POST /api/jobs/:id/cancel` | web | web:apiClient |
| `POST /api/jobs/:id/complete` | runner | runner:(literal)<br>runner:(literal) |
| `GET /api/jobs/:id/events` | runner, web | web:apiClientList<br>runner:(literal)<br>runner:(literal)<br>runner:(literal) |
| `POST /api/jobs/:id/events` | — | — |
| `POST /api/jobs/:id/fail` | runner | runner:(literal) |
| `GET /api/jobs/:id/prompt` | web | web:apiClient |
| `GET /api/knowledge-edges` | web | web:apiClient |
| `POST /api/knowledge-edges` | web | web:apiClient |
| `DELETE /api/knowledge-edges/:id` | web | web:apiClient |
| `POST /api/knowledge/ingest` | web | web:apiClient |
| `DELETE /api/labels/:id` | web | web:apiClient |
| `PATCH /api/labels/:id` | web | web:apiClient |
| `GET /api/me/attention` | web | web:apiClient |
| `GET /api/me/devices` | web | web:apiClient |
| `GET /api/memory` | web | web:apiClientList |
| `POST /api/memory` | — | — |
| `DELETE /api/memory/:id` | web | web:apiClient |
| `DELETE /api/memory/by-source` | — | — |
| `POST /api/memory/search` | web | web:apiClient |
| `GET /api/notifications` | dev, web | web:apiClient<br>dev:request |
| `DELETE /api/notifications/:id` | web | web:apiClient |
| `PATCH /api/notifications/:id` | dev, web | web:apiClient<br>dev:request |
| `POST /api/notifications/mark-all-read` | dev, web | web:apiClient<br>dev:request |
| `GET /api/notifications/unread-count` | dev, web | web:apiClient<br>dev:request |
| `GET /api/pat` | web | web:apiClient |
| `POST /api/pat` | web | web:apiClient |
| `DELETE /api/pat/:id` | web | web:apiClient |
| `GET /api/pat/:id/audit` | web | web:apiClient |
| `POST /api/pat/:id/rotate` | web | web:apiClient |
| `GET /api/pipeline-runs/:id` | web | web:apiClient |
| `POST /api/pipeline-runs/:id/cancel` | web | web:apiClient |
| `POST /api/pipeline-runs/:id/pause` | web | web:apiClient |
| `POST /api/pipeline-runs/:id/resume` | web | web:apiClient |
| `GET /api/pipeline/cycle-time` | web | web:apiClient |
| `GET /api/pipeline/registry` | web | web:apiClient |
| `GET /api/pipeline/step-durations` | web | web:apiClient |
| `GET /api/pipeline/throughput` | web | web:apiClient |
| `GET /api/projects` | dev, web | web:apiClient<br>dev:request<br>dev:request |
| `POST /api/projects` | web | web:apiClient |
| `DELETE /api/projects/:id` | web | web:apiClient |
| `GET /api/projects/:id` | dev, web | web:apiClient<br>dev:request<br>dev:request |
| `PATCH /api/projects/:id` | dev, web | web:apiClient<br>dev:request |
| `GET /api/projects/:id/activity` | — | — |
| `GET /api/projects/:id/analytics/cost-summary` | — | — |
| `GET /api/projects/:id/analytics/cost-trend` | — | — |
| `GET /api/projects/:id/analytics/outliers` | — | — |
| `POST /api/projects/:id/api-key/rotate` | — | — |
| `POST /api/projects/:id/devices/pairing-codes` | web | web:apiClient |
| `GET /api/projects/:id/issues` | dev, web | web:apiClientList<br>dev:request |
| `POST /api/projects/:id/issues` | dev, web | web:apiClient<br>dev:request |
| `GET /api/projects/:id/issues/:issueId/branch-config` | — | — |
| `GET /api/projects/:id/issues/by-display/:displayId` | web | web:apiClient |
| `GET /api/projects/:id/issues/search` | web | web:apiClientList |
| `GET /api/projects/:id/jobs` | web | web:apiClientList |
| `POST /api/projects/:id/jobs` | web | web:apiClient |
| `GET /api/projects/:id/labels` | web | web:apiClient |
| `POST /api/projects/:id/labels` | web | web:apiClient |
| `GET /api/projects/:id/pipeline-config` | web | web:apiClient |
| `PATCH /api/projects/:id/pipeline-config` | web | web:apiClient |
| `GET /api/projects/:id/pipeline-runs` | web | web:apiClientList |
| `POST /api/projects/:id/runners` | web | web:apiClient |
| `DELETE /api/projects/:id/runners/:runnerId` | web | web:apiClient |
| `PATCH /api/projects/:id/runners/:runnerId` | web | web:apiClient |
| `POST /api/projects/:id/skills/bootstrap` | — | — |
| `GET /api/projects/:projectId/integrations` | web | web:apiClient |
| `POST /api/projects/:projectId/integrations` | web | web:apiClient |
| `DELETE /api/projects/:projectId/integrations/:id` | web | web:apiClient |
| `PATCH /api/projects/:projectId/integrations/:id` | web | web:apiClient |
| `POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy` | web | web:apiClient |
| `GET /api/projects/:projectId/integrations/:id/deliveries` | web | web:apiClient |
| `POST /api/projects/:projectId/integrations/:id/rotate-secret` | web | web:apiClient |
| `POST /api/projects/:projectId/integrations/:id/test` | web | web:apiClient |
| `GET /api/projects/:projectId/members` | web | web:apiClient |
| `DELETE /api/projects/:projectId/members/:userId` | web | web:apiClient |
| `PATCH /api/projects/:projectId/members/:userId` | — | — |
| `POST /api/projects/:projectId/members/invite` | web | web:apiClient |
| `GET /api/projects/:projectId/pm/config` | web | web:apiClient |
| `PUT /api/projects/:projectId/pm/config` | web | web:apiClient |
| `GET /api/projects/:projectId/pm/decisions` | web | web:apiClientList |
| `POST /api/projects/:projectId/pm/escalations/:decisionId/respond` | web | web:apiClient |
| `GET /api/projects/:projectId/pm/policies` | web | web:apiClient |
| `POST /api/projects/:projectId/pm/policies` | web | web:apiClient |
| `DELETE /api/projects/:projectId/pm/policies/:id` | web | web:apiClient |
| `PATCH /api/projects/:projectId/pm/policies/:id` | web | web:apiClient |
| `POST /api/projects/:projectId/pm/run` | — | — |
| `GET /api/projects/:projectId/skill-registrations` | web | web:apiClient |
| `DELETE /api/projects/:projectId/skills/:skillId/override` | web | web:apiClient |
| `GET /api/projects/:projectId/skills/:skillId/override` | — | — |
| `PUT /api/projects/:projectId/skills/:skillId/override` | web | web:apiClient |
| `POST /api/projects/:projectId/skills/:skillId/register` | web | web:apiClient |
| `GET /api/projects/:projectId/skills/effective` | dev, web | web:apiClient<br>dev:request |
| `DELETE /api/projects/:projectId/skills/registrations/:stage` | web | web:apiClient |
| `POST /api/projects/:projectId/skills/sync` | — | — |
| `GET /api/projects/health` | web | web:apiClient<br>web:apiClient |
| `POST /api/prompts/preview` | — | — |
| `GET /api/runners` | — | — |
| `POST /api/runners` | — | — |
| `DELETE /api/runners/:id` | — | — |
| `GET /api/runners/:id` | — | — |
| `PATCH /api/runners/:id` | — | — |
| `POST /api/runners/:id/events` | — | — |
| `POST /api/runners/:id/exclude` | — | — |
| `POST /api/runners/:id/health-check` | — | — |
| `POST /api/runners/:id/include` | — | — |
| `POST /api/runners/:id/refresh-quota` | — | — |
| `GET /api/runners/types` | — | — |
| `GET /api/schedules` | web | web:apiClient |
| `POST /api/schedules` | web | web:apiClient |
| `DELETE /api/schedules/:id` | web | web:apiClient |
| `GET /api/schedules/:id` | web | web:apiClient |
| `PUT /api/schedules/:id` | web | web:apiClient |
| `POST /api/schedules/:id/run` | web | web:apiClient |
| `GET /api/skills` | web | web:apiClient |
| `POST /api/skills` | web | web:apiClient |
| `DELETE /api/skills/:id` | web | web:apiClient |
| `GET /api/skills/:id` | web | web:apiClient |
| `PUT /api/skills/:id` | web | web:apiClient |
| `POST /api/skills/bulk-push` | web | web:apiClient |
| `POST /api/skills/sync-status` | web | web:apiClient |
| `DELETE /api/tasks/:taskId` | web | web:apiClient |
| `GET /api/tasks/:taskId` | web | web:apiClient |
| `PATCH /api/tasks/:taskId` | dev, web | web:apiClient<br>dev:request |
| `PUT /api/uploads/:uploadId` | — | — |
| `GET /api/usage-records` | web | web:apiClientList |
| `POST /api/usage-records` | dev | dev:request |
| `GET /api/usage-records/:id` | — | — |
| `POST /api/usage-records/bulk` | — | — |
| `POST /api/usage-records/ingest-cli` | dev, web | web:apiClient<br>dev:request |
| `GET /api/usage-records/summary` | dev, web | web:apiClient<br>dev:request |
| `POST /api/webhooks/in/:slug` | — | — |
| `GET /health` | — | — |
| `GET /install.sh` | — | — |
| `GET /install/bin/:target` | — | — |
| `GET /install/latest.json` | — | — |
| `DELETE /mcp` | — | — |
| `GET /mcp` | — | — |
| `POST /mcp` | — | — |

## Domains

### admin (7)
- `GET /api/admin/audit` → web
- `GET /api/admin/devices` → web
- `POST /api/admin/pipeline/clear-hold/:issueId` → _orphan_
- `GET /api/admin/pipeline/health` → _orphan_
- `GET /api/admin/projects` → web
- `GET /api/admin/users` → web
- `GET /api/admin/whoami` → web

### agent-sessions (28)
- `GET /api/agent-sessions` → web
- `POST /api/agent-sessions` → _orphan_
- `DELETE /api/agent-sessions/:id` → web
- `GET /api/agent-sessions/:id` → web
- `PATCH /api/agent-sessions/:id` → dev, web
- `POST /api/agent-sessions/:id/cancel` → web
- `POST /api/agent-sessions/:id/fork` → web
- `GET /api/agent-sessions/:id/pipeline-control` → _orphan_
- `POST /api/agent-sessions/:id/pipeline-control` → _orphan_
- `GET /api/agent-sessions/:id/pipeline-health` → _orphan_
- `POST /api/agent-sessions/:id/pipeline-health` → _orphan_
- `GET /api/agent-sessions/:id/pipeline-telemetry` → _orphan_
- `POST /api/agent-sessions/:id/pipeline-telemetry` → _orphan_
- `POST /api/agent-sessions/:id/relay` → dev
- `POST /api/agent-sessions/:id/rerun` → web
- `POST /api/agent-sessions/:id/retry` → web
- `GET /api/agent-sessions/:id/turns` → web
- `PATCH /api/agent-sessions/:id/turns/:turnId` → web
- `POST /api/agent-sessions/:id/turns/:turnId/regenerate` → web
- `POST /api/agent-sessions/abort` → web
- `POST /api/agent-sessions/build-prompt` → web
- `GET /api/agent-sessions/desktop/status` → web
- `POST /api/agent-sessions/desktop/status` → _orphan_
- `POST /api/agent-sessions/prompt-built` → dev
- `GET /api/agent-sessions/queue-stats` → web
- `POST /api/agent-sessions/send` → dev, web
- `POST /api/agent-sessions/start` → dev, web
- `POST /api/agent-sessions/sweep-zombies` → web

### agents (5)
- `GET /api/agents` → dev, web
- `POST /api/agents` → web
- `DELETE /api/agents/:id` → web
- `GET /api/agents/:id` → web
- `PATCH /api/agents/:id` → dev, web

### app-config (2)
- `GET /api/app-config/:projectId` → web
- `PUT /api/app-config/:projectId` → web

### auth (20)
- `POST /api/auth/desktop/approve` → _orphan_
- `POST /api/auth/desktop/pair-init` → _orphan_
- `GET /api/auth/desktop/poll` → _orphan_
- `POST /api/auth/dev/force-verify` → _orphan_
- `POST /api/auth/local` → web
- `POST /api/auth/logout` → web
- `GET /api/auth/me` → web
- `GET /api/auth/me/preferences` → web
- `PATCH /api/auth/me/preferences` → web
- `GET /api/auth/oauth/:provider/callback` → _orphan_
- `GET /api/auth/oauth/:provider/reauth-start` → _orphan_
- `GET /api/auth/oauth/:provider/start` → _orphan_
- `GET /api/auth/oauth/providers` → web
- `GET /api/auth/preferences` → web
- `PATCH /api/auth/preferences` → web
- `POST /api/auth/reauth` → web
- `POST /api/auth/refresh` → web
- `POST /api/auth/register` → web
- `GET /api/auth/verify` → _orphan_
- `POST /api/auth/verify` → _orphan_

### chat (6)
- `POST /api/chat` → _orphan_
- `GET /api/chat/sessions` → _orphan_
- `POST /api/chat/sessions` → _orphan_
- `DELETE /api/chat/sessions/:id` → _orphan_
- `GET /api/chat/sessions/:id` → _orphan_
- `PATCH /api/chat/sessions/:id` → _orphan_

### chat-logs (5)
- `GET /api/chat-logs` → web
- `GET /api/chat-logs/:id` → web
- `PATCH /api/chat-logs/:id` → web
- `GET /api/chat-logs/flagged` → _orphan_
- `GET /api/chat-logs/recent` → _orphan_

### comments (7)
- `POST /api/comments/:commentId/attachments` → web
- `DELETE /api/comments/:id` → dev, web
- `PATCH /api/comments/:id` → dev, web
- `GET /api/comments/:id/replies` → _orphan_
- `GET /api/comments/attachments/:id` → _orphan_
- `GET /api/issues/:id/comments` → dev, web
- `POST /api/issues/:id/comments` → dev, web

### devices (9)
- `DELETE /api/devices/:id` → dev, web
- `PATCH /api/devices/:id` → web
- `GET /api/devices/:id/runners` → web
- `POST /api/devices/heartbeat` → runner
- `GET /api/devices/me/runners` → runner
- `PATCH /api/devices/me/runners/:runnerId` → runner
- `POST /api/devices/pair` → runner
- `GET /api/me/devices` → web
- `POST /api/projects/:id/devices/pairing-codes` → web

### domain-templates (3)
- `GET /api/domain-templates` → _orphan_
- `GET /api/domain-templates/:key` → _orphan_
- `POST /api/domain-templates/apply` → _orphan_

### install (3)
- `GET /install.sh` → _orphan_
- `GET /install/bin/:target` → _orphan_
- `GET /install/latest.json` → _orphan_

### integrations (8)
- `GET /api/projects/:projectId/integrations` → web
- `POST /api/projects/:projectId/integrations` → web
- `DELETE /api/projects/:projectId/integrations/:id` → web
- `PATCH /api/projects/:projectId/integrations/:id` → web
- `POST /api/projects/:projectId/integrations/:id/confirm-prod-deploy` → web
- `GET /api/projects/:projectId/integrations/:id/deliveries` → web
- `POST /api/projects/:projectId/integrations/:id/rotate-secret` → web
- `POST /api/projects/:projectId/integrations/:id/test` → web

### issues (27)
- `DELETE /api/attachments/:id` → web
- `GET /api/attachments/:id/download` → _orphan_
- `DELETE /api/issues/:id` → web
- `GET /api/issues/:id` → dev, web
- `PATCH /api/issues/:id` → dev, web
- `GET /api/issues/:id/activity` → web
- `DELETE /api/issues/:id/activity/:activityId` → web
- `PATCH /api/issues/:id/activity/:activityId/evaluate` → web
- `GET /api/issues/:id/attachments` → web
- `POST /api/issues/:id/attachments` → web
- `GET /api/issues/:id/cost-summary` → dev, web
- `POST /api/issues/:id/decompose` → web
- `GET /api/issues/:id/dependencies` → web
- `POST /api/issues/:id/dependencies` → web
- `DELETE /api/issues/:id/dependencies/:edgeId` → web
- `POST /api/issues/:id/enrich` → dev, web
- `GET /api/issues/:id/job-history` → web
- `PATCH /api/issues/:id/manual-hold` → web
- `POST /api/issues/:id/run-pipeline-step` → web
- `POST /api/issues/:id/transition` → dev, web
- `PATCH /api/issues/batch` → web
- `GET /api/issues/pipeline-timing` → web
- `GET /api/projects/:id/activity` → _orphan_
- `GET /api/projects/:id/issues` → dev, web
- `POST /api/projects/:id/issues` → dev, web
- `GET /api/projects/:id/issues/by-display/:displayId` → web
- `GET /api/projects/:id/issues/search` → web

### jobs (10)
- `GET /api/jobs/:id` → web
- `PATCH /api/jobs/:id` → _orphan_
- `POST /api/jobs/:id/cancel` → web
- `POST /api/jobs/:id/complete` → runner
- `GET /api/jobs/:id/events` → runner, web
- `POST /api/jobs/:id/events` → _orphan_
- `POST /api/jobs/:id/fail` → runner
- `GET /api/jobs/:id/prompt` → web
- `GET /api/projects/:id/jobs` → web
- `POST /api/projects/:id/jobs` → web

### knowledge (1)
- `POST /api/knowledge/ingest` → web

### knowledge-edges (3)
- `GET /api/knowledge-edges` → web
- `POST /api/knowledge-edges` → web
- `DELETE /api/knowledge-edges/:id` → web

### labels (4)
- `DELETE /api/labels/:id` → web
- `PATCH /api/labels/:id` → web
- `GET /api/projects/:id/labels` → web
- `POST /api/projects/:id/labels` → web

### me (1)
- `GET /api/me/attention` → web

### memory (5)
- `GET /api/memory` → web
- `POST /api/memory` → _orphan_
- `DELETE /api/memory/:id` → web
- `DELETE /api/memory/by-source` → _orphan_
- `POST /api/memory/search` → web

### misc (4)
- `GET /health` → _orphan_
- `DELETE /mcp` → _orphan_
- `GET /mcp` → _orphan_
- `POST /mcp` → _orphan_

### notifications (5)
- `GET /api/notifications` → dev, web
- `DELETE /api/notifications/:id` → web
- `PATCH /api/notifications/:id` → dev, web
- `POST /api/notifications/mark-all-read` → dev, web
- `GET /api/notifications/unread-count` → dev, web

### pat (5)
- `GET /api/pat` → web
- `POST /api/pat` → web
- `DELETE /api/pat/:id` → web
- `GET /api/pat/:id/audit` → web
- `POST /api/pat/:id/rotate` → web

### pipeline (15)
- `DELETE /api/issue-step-contexts` → _orphan_
- `GET /api/issue-step-contexts` → _orphan_
- `POST /api/issue-step-contexts` → _orphan_
- `GET /api/pipeline-runs/:id` → web
- `POST /api/pipeline-runs/:id/cancel` → web
- `POST /api/pipeline-runs/:id/pause` → web
- `POST /api/pipeline-runs/:id/resume` → web
- `GET /api/pipeline/cycle-time` → web
- `GET /api/pipeline/registry` → web
- `GET /api/pipeline/step-durations` → web
- `GET /api/pipeline/throughput` → web
- `GET /api/projects/:id/analytics/cost-summary` → _orphan_
- `GET /api/projects/:id/analytics/cost-trend` → _orphan_
- `GET /api/projects/:id/analytics/outliers` → _orphan_
- `GET /api/projects/:id/pipeline-runs` → web

### pm (9)
- `GET /api/projects/:projectId/pm/config` → web
- `PUT /api/projects/:projectId/pm/config` → web
- `GET /api/projects/:projectId/pm/decisions` → web
- `POST /api/projects/:projectId/pm/escalations/:decisionId/respond` → web
- `GET /api/projects/:projectId/pm/policies` → web
- `POST /api/projects/:projectId/pm/policies` → web
- `DELETE /api/projects/:projectId/pm/policies/:id` → web
- `PATCH /api/projects/:projectId/pm/policies/:id` → web
- `POST /api/projects/:projectId/pm/run` → _orphan_

### projects (20)
- `GET /api/invitations/:token` → _orphan_
- `POST /api/invitations/:token/accept` → _orphan_
- `GET /api/projects` → dev, web
- `POST /api/projects` → web
- `DELETE /api/projects/:id` → web
- `GET /api/projects/:id` → dev, web
- `PATCH /api/projects/:id` → dev, web
- `POST /api/projects/:id/api-key/rotate` → _orphan_
- `GET /api/projects/:id/issues/:issueId/branch-config` → _orphan_
- `GET /api/projects/:id/pipeline-config` → web
- `PATCH /api/projects/:id/pipeline-config` → web
- `POST /api/projects/:id/runners` → web
- `DELETE /api/projects/:id/runners/:runnerId` → web
- `PATCH /api/projects/:id/runners/:runnerId` → web
- `POST /api/projects/:id/skills/bootstrap` → _orphan_
- `GET /api/projects/:projectId/members` → web
- `DELETE /api/projects/:projectId/members/:userId` → web
- `PATCH /api/projects/:projectId/members/:userId` → _orphan_
- `POST /api/projects/:projectId/members/invite` → web
- `GET /api/projects/health` → web

### prompt (1)
- `POST /api/prompts/preview` → _orphan_

### runners (11)
- `GET /api/runners` → _orphan_
- `POST /api/runners` → _orphan_
- `DELETE /api/runners/:id` → _orphan_
- `GET /api/runners/:id` → _orphan_
- `PATCH /api/runners/:id` → _orphan_
- `POST /api/runners/:id/events` → _orphan_
- `POST /api/runners/:id/exclude` → _orphan_
- `POST /api/runners/:id/health-check` → _orphan_
- `POST /api/runners/:id/include` → _orphan_
- `POST /api/runners/:id/refresh-quota` → _orphan_
- `GET /api/runners/types` → _orphan_

### schedules (6)
- `GET /api/schedules` → web
- `POST /api/schedules` → web
- `DELETE /api/schedules/:id` → web
- `GET /api/schedules/:id` → web
- `PUT /api/schedules/:id` → web
- `POST /api/schedules/:id/run` → web

### skills (15)
- `GET /api/projects/:projectId/skill-registrations` → web
- `DELETE /api/projects/:projectId/skills/:skillId/override` → web
- `GET /api/projects/:projectId/skills/:skillId/override` → _orphan_
- `PUT /api/projects/:projectId/skills/:skillId/override` → web
- `POST /api/projects/:projectId/skills/:skillId/register` → web
- `GET /api/projects/:projectId/skills/effective` → dev, web
- `DELETE /api/projects/:projectId/skills/registrations/:stage` → web
- `POST /api/projects/:projectId/skills/sync` → _orphan_
- `GET /api/skills` → web
- `POST /api/skills` → web
- `DELETE /api/skills/:id` → web
- `GET /api/skills/:id` → web
- `PUT /api/skills/:id` → web
- `POST /api/skills/bulk-push` → web
- `POST /api/skills/sync-status` → web

### tasks (6)
- `GET /api/issues/:id/tasks` → dev, web
- `POST /api/issues/:id/tasks` → web
- `POST /api/issues/:id/tasks/reorder` → web
- `DELETE /api/tasks/:taskId` → web
- `GET /api/tasks/:taskId` → web
- `PATCH /api/tasks/:taskId` → dev, web

### uploads (1)
- `PUT /api/uploads/:uploadId` → _orphan_

### usage-records (6)
- `GET /api/usage-records` → web
- `POST /api/usage-records` → dev
- `GET /api/usage-records/:id` → _orphan_
- `POST /api/usage-records/bulk` → _orphan_
- `POST /api/usage-records/ingest-cli` → dev, web
- `GET /api/usage-records/summary` → dev, web

### webhooks (1)
- `POST /api/webhooks/in/:slug` → _orphan_

