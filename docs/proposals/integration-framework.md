# Proposal: Integration Framework (Coolify + Sentry + Human-Task)

- **Status:** Draft proposal (pre-RFC)
- **Date:** 2026-05-22 (recovered & re-saved 2026-05-26)
- **Scope:** External-system integrations for Forge projects — deploy automation (Coolify), error tracking (Sentry), human-task tool (team-internal). Frame as one polymorphic framework rather than three independent modules.
- **Affects:** `packages/core` (schema, event bus, adapter registry, vault), `packages/web` (`/settings/integrations` UI)

## 1. Problem

User wants to wire three external systems into Forge projects:

1. **Coolify** — trigger deploys at the `release` step, complete/fail the step from Coolify webhooks.
2. **Sentry** — auto-create Forge issues from alerts, list unresolved errors in the project UI.
3. **Human-Task tool** (team-internal PM tool) — bidirectional sync: tool creates tasks → Forge auto-pipelines them → Forge reports back.

Audit of current state:

| Surface | State | Action |
|---|---|---|
| Coolify | UI stub only: `packages/web/src/app/projects/[slug]/settings/components/coolify-section.tsx` (`previewMode=true`). No schema, no route, no skill. | Build from 0 |
| Sentry (user-project Sentry) | UI stub only: `packages/web/src/app/projects/[slug]/settings/components/sentry-section.tsx`. Note: `packages/core/src/observability/sentry.ts` is *Forge's own* Sentry, unrelated. | Build from 0 |
| Outbound webhooks | Shipped: `projectWebhooks` table (`packages/core/src/db/schema.ts:795`), HMAC-SHA256 signing, retry via pg-boss. Only GitHub adapter. | Generalize |
| Inbound webhooks | `POST /in/:slug` verifies HMAC, dispatches by hardcoded provider check. | Refactor to registry |

**Insight:** Coolify / Sentry / Human-Task share the same shape (configured per-project, secrets, inbound + outbound webhooks, audit log, retry). Building them independently would triple the schema, UI shell, retry wiring, and audit log work. Build a single integration framework instead — each of the three becomes an *adapter*. Future providers (Linear, Slack, Jira, GitLab CI) are then one adapter file each.

## 2. Non-goals (v1)

- Payload template editor (Handlebars/JSONata) — fix one schema, adapt on the other side.
- KMS-backed key management — `INTEGRATION_MASTER_KEY` env var is sufficient.
- Per-section settings pages — one shared `/settings/integrations` marketplace UI.
- Backward-compat shims for the existing `projectWebhooks` row shape — re-tag as `provider='generic_webhook'` and migrate forward.

## 3. Architecture — 4 layers

```
┌─────────────────────────────────────────────────────────┐
│ Layer 4 — UI         /settings/integrations             │
├─────────────────────────────────────────────────────────┤
│ Layer 3 — Adapters   coolify | sentry | humantask | ... │  ← add provider = 1 file
├─────────────────────────────────────────────────────────┤
│ Layer 2 — Framework  EventBus, AdapterRegistry, Vault,  │
│                      DeliveryLog, RetryPolicy, Health   │
├─────────────────────────────────────────────────────────┤
│ Layer 1 — Storage    project_integrations (1 table)     │
│                      integration_deliveries (audit)     │
└─────────────────────────────────────────────────────────┘
```

**Rule:** Layer 2 is shared code. Layer 3 is provider-specific logic.

### Adapter contract

Each adapter implements:

```ts
interface IntegrationAdapter<TConfig> {
  validateConfig(config: TConfig): Promise<ValidationResult>;
  healthcheck(ctx: AdapterContext): Promise<HealthStatus>;
  handleInbound(ctx: AdapterContext, headers, body): Promise<void>;
  dispatchOutbound(ctx: AdapterContext, event: ForgeEvent): Promise<void>;
  pollState?(ctx: AdapterContext): Promise<void>;   // optional
}
```

## 4. Schema

```sql
CREATE TABLE project_integrations (
  id              uuid PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider        text NOT NULL,            -- 'coolify' | 'sentry' | 'humantask' | 'generic_webhook' | ...
  active          boolean NOT NULL DEFAULT true,
  config          jsonb NOT NULL,           -- per-adapter shape (resource_uuid, sentry_org_slug, callback_url, ...)
  secrets_enc     bytea NOT NULL,           -- AES-256-GCM with env master key (KMS-ready later)
  events          text[] NOT NULL DEFAULT '{}',   -- subscribed outbound events
  state           jsonb NOT NULL DEFAULT '{}',    -- last_sync_at, deploy_uuid_map, errors_cache, ...
  health          jsonb NOT NULL DEFAULT '{}',    -- {status, last_check_at, message}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_deliveries (
  id                       uuid PRIMARY KEY,
  project_integration_id   uuid NOT NULL REFERENCES project_integrations(id) ON DELETE CASCADE,
  direction                text NOT NULL,    -- 'in' | 'out'
  event_name               text NOT NULL,
  payload                  jsonb NOT NULL,
  signature                text,
  status_code              int,
  attempt                  int NOT NULL DEFAULT 1,
  status                   text NOT NULL,    -- 'pending' | 'ok' | 'failed' | 'retrying'
  request_id               text,             -- idempotency key
  error_message            text,
  duration_ms              int,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_integration_id, request_id)   -- idempotency
);

CREATE INDEX ON integration_deliveries (project_integration_id, created_at DESC);
```

Existing `projectWebhooks` rows: migrate by inserting matching `project_integrations` rows with `provider='generic_webhook'`; drop the old table once all consumers cut over.

## 5. Event bus

Generalize the current single-hook (`transition`) into a typed bus:

```ts
type ForgeEvent =
  | { name: 'issue.created'; issueId: string; ... }
  | { name: 'issue.status_changed'; issueId: string; from: Status; to: Status }
  | { name: 'issue.comment_added'; issueId: string; commentId: string }
  | { name: 'pipeline.started'; runId: string; issueId: string }
  | { name: 'pipeline.step_completed'; runId: string; step: string }
  | { name: 'pipeline.failed'; runId: string; reason: string }
  | { name: 'pipeline.escalated_to_human'; runId: string; reason: string }
  | { name: 'agent.session_stuck'; sessionId: string }
  | { name: 'release.requested'; projectId: string; version: string }
  | { name: 'release.completed'; projectId: string; version: string; deploymentUrl?: string }
  | { name: 'release.failed'; projectId: string; version: string; error: string };
```

Emitted from the pipeline orchestrator. Outbound dispatch filters by `project_integrations.events[]`.

## 6. Inbound adapter registry

Replace the hardcoded GitHub branch with a registry:

```ts
inboundAdapters.register('coolify', {
  detect: (headers) => 'x-coolify-event' in headers,
  verify: (body, sig, secret) => verifyHmac(body, sig, secret),
  handle: async (ctx, payload) => {
    if (payload.event === 'deploy.success') {
      await pipelineRuns.completeStep(ctx.projectId, payload.resource_uuid, 'release');
    }
  },
});
```

Endpoint: `POST /in/:slug?provider=<name>`, or auto-detected from headers (`x-coolify-event`, `sentry-hook-resource`, ...).

## 7. Adapters — concrete designs

### 7.1 Coolify (deploy automation)

**Outbound flow**

```
[pipeline step "release" reaches orchestrator]
   → check project_integrations(provider=coolify, active=true)
   → coolifyAdapter.dispatchOutbound
   →   GET /api/v1/deploy?uuid={config.resource_uuid}&force=true   (Bearer token)
   →   Coolify returns deployment_uuid
   →   integration.state.deploy_uuid_map[deployment_uuid] = step_id
   →   set step status = "in_progress"
```

**Inbound flow**

```
[Coolify webhook: deploy.success | deploy.failed]
   → POST /in/<slug>
   → coolifyAdapter.handleInbound
   → lookup state.deploy_uuid_map[deployment_uuid] → step_id
   → success: complete step + comment "✅ Deployed v1.2.3"
   → failed:  fail step + auto-create issue "release_failed"
              + attach Coolify logs_url
              + circuit breaker: 3 consecutive fails → pause auto-deploy, escalate human
```

**Coolify API (v1) — relevant endpoints**

| Method | Path | Use |
|---|---|---|
| `GET` | `/api/v1/deploy?uuid=&tag=&force=&pr=&docker_tag=` | Trigger deploy. Returns `{ deployments: [{ deployment_uuid, resource_uuid, message }] }` |
| `POST` | `/api/v1/deploy` (JSON body `{uuid, tag, force}`) | Same as above |
| `POST` | `/api/v1/cancel-deployment/{uuid}` | Cancel running deploy |
| `GET` | `/api/v1/list-deployments` | All deployments |
| `GET` | `/api/v1/list-deployments-by-app-uuid` | Filtered by app |
| `GET` | `/api/v1/start|stop|restart/{uuid}` | Resource lifecycle |

Auth: Bearer token from Coolify UI → Keys & Tokens → API tokens.

**Config schema**

```json
{
  "api_base_url": "https://coolify.team.local",
  "api_token": "<encrypted in secrets_enc>",
  "resource_uuid_staging": "app-staging-xyz",
  "resource_uuid_prod": "app-prod-xyz",
  "force_rebuild": false,
  "circuit_breaker_threshold": 3,
  "deployment_timeout_minutes": 30,
  "health_check_interval_minutes": 5
}
```

**Edge cases**

- Circuit breaker: 3 consecutive fails → pause `active=false`, emit `pipeline.escalated_to_human`.
- Health check polling (5 min): `GET /api/v1/resources/{uuid}` → `integration.health`.
- Multi-env gate: staging deploy auto, prod deploy requires manual approval action in the UI.
- Timeout: if no inbound webhook within `deployment_timeout_minutes`, fail step + escalate.

### 7.2 Sentry (error tracking — read-side + alert)

**Push flow (Sentry → Forge)**

```
[Sentry alert rule fires on user's project]
   → POST webhook to Forge (when config.webhook_enabled)
   → sentryAdapter.handleInbound (verify "Client Security" signature)
   → if auto_create_issue:
        create Forge issue {
          title: sentry.title,
          body: stacktrace + sentry_url,
          labels: ['from-sentry', severity],
          external_refs: { sentry_issue_id, sentry_url }
        }
   → dedup: if sentry_issue_id already linked → comment "Recurrence" instead of new issue
```

**Pull flow (Forge UI → Sentry)**

```
[project page → tab "Errors" → click refresh]
   → sentryAdapter.pollState
   → GET https://sentry/api/0/projects/{org}/{slug}/issues/?query=is:unresolved
   → cache in integration.state.errors_cache (60s TTL)
   → render list, each row links to Sentry
```

**Config schema**

```json
{
  "sentry_org_slug": "my-org",
  "sentry_project_slug": "my-project",
  "api_token": "<encrypted>",
  "webhook_enabled": true,
  "auto_create_issue": true,
  "auto_create_label": "from-sentry",
  "auto_resolve_on_close": false,
  "poll_interval_minutes": 5
}
```

**Edge cases**

- Severity mapping: `error` → high, `warning` → medium, `info` → low.
- Two-way linkage: Forge issue stores Sentry URL; on auto-create, set Sentry issue tag `forge_issue = <id>`.
- Auto-resolve (opt-in): when Forge issue closes → `PUT /api/0/issues/{id}/ {status:'resolved'}`.

### 7.3 Human-Task tool (bidirectional, tool is source of truth)

**Inbound (tool → Forge)**

```
[PM tool creates a task that needs Forge implementation]
   → POST /in/<slug>
   → humantaskAdapter.handleInbound
   → parse {task_id, title, description, priority, labels, ...}
   → create Forge issue with external_refs.humantask_id = task_id
   → if config.auto_start_label matches labels → add label that triggers pipeline
```

**Outbound (Forge → tool)**

```
[Forge pipeline step completes/fails / issue status changes]
   → humantaskAdapter.dispatchOutbound
   → POST {config.tool_callback_url} {task_id, forge_issue_id, status, result_url}
   → JWT in Authorization header (24h TTL, signed by master key)
```

**Inbound payload**

```json
{
  "forgeProjectId": "proj-123",
  "taskId": "task-456",
  "title": "Review PR #42 security",
  "description": "Check auth bypass in login flow",
  "priority": "high",
  "labels": ["security", "review"],
  "estimateHours": 4,
  "callbackUrl": "https://tool.team.local/webhooks/forge-feedback"
}
```

**Outbound payload**

```json
{
  "taskId": "task-456",
  "forgeIssueId": "PROJ-123",
  "status": "completed",
  "result": "Approved with 2 minor issues found",
  "resultUrl": "https://forge.team.local/i/PROJ-123",
  "timestamp": "2026-05-22T16:30:00Z"
}
```

**Config schema**

```json
{
  "tool_callback_url": "https://tool.team.local/webhooks/forge-feedback",
  "auto_start_label": "urgent",
  "field_mapping": {
    "forge_priority": "priority",
    "forge_labels": ["labels"]
  },
  "loop_sync_guard_minutes": 30
}
```

**Edge cases**

- Loop-sync guard: track `(task_id, forge_issue_id)` mapping; suppress outbound within `loop_sync_guard_minutes` of an inbound for the same pair.
- Idempotency: `X-Request-Id` header (UNIQUE constraint on `integration_deliveries`).
- Tool down: pipeline blocks at the relevant step; retry forever with exponential backoff; circuit breaker after N hours → escalate.

## 8. Cross-cutting concerns

- **Idempotency.** All inbound deliveries must carry `X-Request-Id`. UNIQUE `(project_integration_id, request_id)`. Duplicate → 200 OK, no re-process. Fallback key: `sha256(body)`.
- **Secret rotation.** Store `webhook_secret` + `webhook_secret_previous`; accept both for N hours. UI "Rotate" button.
- **Outbound coalescing.** 5 fails within 1 minute → emit one `pipeline.failing_repeatedly` event instead of 5 separate notifications.
- **Replay from UI.** `integration_deliveries` page has a "Retry" button.
- **Test mode.** UI "Send test event" button — fires a sample payload through the same path, no real DB effect.
- **Health polling worker.** Single pg-boss job runs every 1 min, queries `WHERE active AND poll_interval_minutes`, invokes `adapter.pollState()`.
- **Sentry observability for Forge itself.** Wrap every adapter call in span `integration.${provider}.${direction}`.
- **Per-event opt-in.** UI checkboxes per integration: "Send when ☑ pipeline failed ☐ issue created ☑ agent escalated".
- **Payload versioning.** Header `X-Forge-Payload-Version: v1`. Bumped when shape changes; old + new supported in parallel during deprecation window.

## 9. Decisions already locked

1. **Encryption:** env `INTEGRATION_MASTER_KEY` (AES-256-GCM). No KMS in v1.
2. **Payload shape:** fixed schema; the *other side* adapts. No template editor.
3. **UI:** one marketplace page at `/settings/integrations`. No per-provider settings tab.
4. **Multi-env (Coolify):** separate `resource_uuid_staging` + `resource_uuid_prod`, manual approval to promote.
5. **Failure semantics:** pipeline *blocks* when an external tool is down; retry forever; circuit breaker after N attempts escalates to a human.

## 10. Roadmap

| Sprint | Scope | Effort |
|---|---|---|
| 1 | Framework foundation: schema migration, event bus, adapter registry (port GitHub), vault, marketplace UI shell, delivery-log table + UI | 3–5 days |
| 2 | Human-Task adapter (inbound + outbound), loop-sync guard, test-event button | 2–3 days |
| 3 | Sentry adapter (push + pull, dedup) **and** Coolify adapter (dispatch + webhook receiver + circuit breaker + health) — parallelizable | 5–7 days |

Total: **10–15 working days (2–3 weeks)**.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Adapter contract too abstract — provider edge cases leak into framework | Ship GitHub adapter as the reference; document each hook with the Coolify use case |
| JSONB `config` becomes a typeless dumping ground | Per-adapter Zod schema + `validateConfig()` in the contract; reject on save |
| Secret leak in audit log | Redact `secrets_enc` and any header matching the existing scrubber list; log signature-verification result only |
| External tool flapping floods deliveries table | Outbound coalescing + `integration_deliveries` retention cron (mirror `pipeline_run_step_durations` pattern) |
| Inbound idempotency key collision | UNIQUE `(integration_id, request_id)`; fallback `sha256(body)` when header missing |

## 12. Open questions

- Sentry dedup: store `(sentry_issue_id, forge_issue_id)` in `integration.state` JSON or split into a dedicated table once volume grows?
- Should the framework expose an outbound queue API for adapters that need ordering guarantees (e.g. status-change sequences), or is best-effort ordering acceptable?
- Webhook proxy mode for tools behind a firewall: `GET /api/integrations/pending?token=...` poll endpoint — v1 or v2?

## References

- [Coolify API — Deploy](https://coolify.io/docs/api-reference/api/operations/deploy-by-tag-or-uuid)
- [Coolify API Reference](https://coolify.io/docs/api-reference/api/)
- `packages/core/src/db/schema.ts:795` — `projectWebhooks` (generalize to `project_integrations`)
- `packages/web/src/app/projects/[slug]/settings/components/coolify-section.tsx` — existing UI stub (`previewMode=true`)
- `packages/web/src/app/projects/[slug]/settings/components/sentry-section.tsx` — existing UI stub
