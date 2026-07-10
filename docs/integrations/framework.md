# Integration Framework

One polymorphic framework connecting projects to external systems (deploy, error tracking, …): shared Layer 2 (storage + vault + queue + delivery log), one adapter per provider (Layer 3).

Origin: the former `integration-framework` proposal (retired). This doc = SHIPPED reality, narrower than the proposal.

## What actually shipped

| Piece | Status |
|-------|--------|
| Framework foundation (registry, vault, store, delivery log, queue) | Shipped (ISS-234) |
| **Coolify** adapter (deploy + logs + circuit breaker) | Shipped, live |
| **Postman** + **Epodsystem** + **Sentry** adapters (MCP-injecting) | Shipped, live |
| **Rocket.Chat** adapter (inbound chat, connection-only, no MCP) | Shipped, live |
| Inbound webhook routing via adapter registry | Shipped (Coolify header only) |
| **Sentry** | Dual role: Forge's own observability (breadcrumbs) AND a per-project MCP-injection adapter (`injectsMcp:true`, ISS-524) |
| GitHub inbound webhook | Shipped, but **legacy path** — not an `IntegrationAdapter` (see [README](README.md)) |

`IntegrationProvider` = the 5-value union `'coolify' | 'postman' | 'epodsystem' | 'sentry' | 'rocketchat'` (`packages/core/src/integrations/types.ts`). All five adapters register at boot (`registerCoolifyAdapter()` / `registerPostmanAdapter()` / `registerEpodsystemAdapter()` / `registerSentryAdapter()` / `registerRocketChatAdapter()` in `src/index.ts`).

## Architecture (3 layers, as built)

```
Layer 3 — Adapters    coolify/ · postman/ · epodsystem/ · sentry/ · rocketchat/   (all registered at boot)
Layer 2 — Framework   registry · vault · store · deliveries · queue · circuit-breaker
Layer 1 — Storage     integration_connections (credential) + integration_bindings
                      (per-project attach, 1 row per project+provider+env)
                      integration_deliveries (audit / idempotency, keyed by binding_id)
```

All under `packages/core/src/integrations/`.

### Adapter contract

`packages/core/src/integrations/types.ts` — `IntegrationAdapter<TConfig, TSecrets>`:

```ts
interface IntegrationAdapter<TConfig, TSecrets> {
  readonly provider: IntegrationProvider;
  readonly capabilities?: IntegrationCapabilities;
  healthcheck(ctx): Promise<HealthCheckResult>;
  dispatchOutbound(ctx, input: OutboundDispatchInput): Promise<OutboundDispatchResult>;
  handleInbound(ctx, input: InboundDispatchInput): Promise<InboundDispatchResult>;
}
```

- `validateConfig` / `pollState` from the proposal **not** shipped; config validation lives in the route's Zod schema.
- `AdapterContext` carries `config`, decrypted `secrets`, `integrationSecret` (inbound HMAC key).

### Registry

`registry.ts` — in-memory `Map<provider, adapter>`. `registerAdapter` (dup = throw), `getAdapter`, `listAdapters`. All five adapters register at boot in `src/index.ts` (`registerCoolifyAdapter()` / `registerPostmanAdapter()` / `registerEpodsystemAdapter()` / `registerSentryAdapter()` / `registerRocketChatAdapter()`).

### Vault (secret encryption)

`vault.ts` — AES-256-GCM with `INTEGRATION_MASTER_KEY` env var (hex-64 or base64, must decode to 32 bytes). Ciphertext layout `<iv:12><tag:16><ciphertext>`, stored in `integration_connections.secrets_enc` (`bytea`). No KMS (matches proposal §9.1).

- `isVaultConfigured()` — pure presence check; routes turn a missing key into a 503 (`VAULT_NOT_CONFIGURED`) before any encrypt/decrypt.
- `assertVaultBootSafety()` — boot guard: refuses to start if key missing **and** any active connection row exists. Fresh OSS installs with no integrations boot fine without a key.

### Storage

`store.ts` over the connection/binding model in `db/schema.ts` (~line 2160). `project_integrations` was **retired by ISS-410** (epic ISS-404) — see [connection-binding.md](connection-binding.md) for the split.

- **`integration_connections`** — the CREDENTIAL (owner-scoped): `provider, secrets_enc (bytea), active`. Indexed on `(owner, provider)`.
- **`integration_bindings`** — the per-project ATTACH: `connection_id (FK cascade), project_id, provider, environment ('staging'|'prod'), config (jsonb), integration_secret (HMAC key), label (ISS-558; '' = default binding), active`. Unique on `(project_id, provider, environment, label)` — `label=''` for non-epodsystem preserves the one-row-per-(project, provider, env) guard while allowing multiple labeled epodsystem bindings. Breaker/health state (`breaker_opened_at`, `last_health_status`, `last_health_at`) lives on `integration_connections`, not the binding.
- **`integration_deliveries`** — audit + idempotency: `direction ('outbound'|'inbound'), event_name, request_id, status ('pending'|'ok'|'failed'), payload, response, error_message, duration_ms`, keyed by `binding_id`. Partial unique index on `(binding_id, request_id)` where `request_id IS NOT NULL` (idempotency). Soft-delete = `active=false`.

Shipped schema differs from proposal: `environment` is a real column (not in config); no `events[]` / `state` / `health` jsonb; breaker state is just `active` + `breaker_opened_at`.

### Delivery log

`deliveries.ts` — `recordDelivery` / `updateDelivery` plus breaker/idempotency queries: `recentOutboundDeliveries` (breaker), `findLastOutbound` (status), `findDeliveryByRequestId` (dedup), `findLastSuccessfulOutbound`.

### Queue

`queue.ts` — outbound dispatch runs through pg-boss queue `INTEGRATIONS_QUEUE_NAME`. `enqueueCoolifyDispatch` (5× retry, exp backoff, `singletonKey=requestId`) → `registerIntegrationsWorker` consumer → `coolifyAdapter.dispatchOutbound`. Worker is **Coolify-specific today** (job kind `coolify.dispatch`); generalizing it is a future step.

## Coolify adapter

`packages/core/src/integrations/coolify/` — deploy automation for the pipeline `release` step.

- `client.ts` — `CoolifyClient`. Deploy is `GET /api/v1/deploy?uuid=&force=` (NOT a POST body). Healthcheck lists `/api/v1/resources` and matches the uuid client-side (the get-one path 404s). `getDeployment` fetches status + logs. Bearer auth; 401 falls back to `previousApiToken` during the rotation window.
- `adapter.ts` — `coolifyAdapter`:
  - `dispatchOutbound` — re-checks `active` (breaker may have opened), records a `pending` delivery, calls `deploy({force:true})` (always force-rebuild, ISS-290), stores `deployment_uuid` in the delivery `response`, marks `ok` / resets breaker — or marks `failed` and may trip the breaker.
  - `handleInbound` — verifies HMAC (`x-coolify-signature-256` etc.), looks up the outbound delivery whose `response.deployment_uuid` matches the webhook, reads its `runId`, advances the run: `success` → `setCurrentStepForce(runId, 'release.deploy.done')` + `closeRun(runId,'completed')`; `failed` → `…failed` + `closeRun(…,'failed')`.
  - `healthcheck` — reaches the resource, stamps `last_health_status/at`.
  - `fetchCoolifyDeploymentLogs` — standalone (not on the interface): fetch log, scrub secrets line-by-line (incl. the integration's own `apiToken`), tail to ~100 lines / ~16KB.
- `circuit-breaker.ts` — **3 consecutive failed outbound deliveries within 5 min** trips it: flips `active=false`, stamps `breaker_opened_at`, emits a Sentry message. `active` *is* the breaker state. A later successful dispatch resets it.

### Deploy trigger (outbound)

`packages/core/src/pipeline/release-coolify.ts`:

- `registerReleaseCompletedSubscriber` — on a completed `release` job, resolves the issue's latest run and calls `tryDispatchCoolifyRelease`.
- `tryDispatchCoolifyRelease` — per active Coolify row: **staging** auto-enqueues; **prod** is gated behind human confirm (`pending_human`, stored on `pipelineRuns.metadata.__forge_prod_deploy_gate`) until `POST /…/integrations/:id/confirm-prod-deploy` → `confirmPendingProdDeploy`. Per-attempt `requestId` (`${runId}:${integrationId}:${ts}-${rand}`) so a re-deploy after a fix fires a fresh build. No Coolify configured → no-op (`release.deploy.skipped`).

### MCP tool — `forge_coolify_deploy`

`packages/core/src/mcp/tools/forge-coolify-deploy.ts`. Actions: `list` (active integrations; empty ⇒ local-only) · `deploy` (needs `issueId`; reuses `tryDispatchCoolifyRelease`, honors the prod gate) · `status` (latest outbound per integration) · `logs` (scrubbed + tailed deploy log). Auth = project membership.

## Inbound webhook routing

`packages/core/src/webhooks/inbound-routes.ts` — `POST /in/:slug`:

1. Read raw body (HMAC covers untouched bytes), resolve project by slug.
2. **Provider header** present (`PROVIDER_HEADER_MAP`: `x-coolify-event` → `coolify`) → dispatch through the adapter registry. With staging+prod rows for the same provider, the matching row is found by verifying the signature against each row's own `integration_secret` (multi-env disambiguation).
3. Otherwise fall through to the **legacy GitHub / generic** path (uses `projects.webhookSecret`, `handleGitHubEvent`) — kept verbatim, not an adapter.

## Sentry

Sentry plays **two** roles. (1) **Forge's own observability**: `packages/core/src/observability/sentry.ts` (`isSentryEnabled`, `Sentry`) is opt-in via `SENTRY_DSN` env var (see CLAUDE.md → Observability). Framework uses it for breadcrumbs (`integration.coolify.dispatch` / `.inbound`); a tripped breaker captures `integration.coolify.breaker_tripped`. (2) **A per-project MCP-injection adapter** (`integrations/sentry/adapter.ts`, `injectsMcp:true`, ISS-524) — like Postman/Epodsystem it injects an MCP server config into agents; it makes no direct outbound/inbound delivery calls. The integrations status endpoint also reports a Sentry card driven by `SENTRY_DSN` presence.

## REST surface

Project-scoped router, all under `/api/projects/:projectId/integrations` (`integrations/routes.ts`, auth = project member; create/update/delete require owner/admin):

| Method | Path | Use |
|--------|------|-----|
| GET | `/` | list integrations (summarized; secrets never returned) |
| POST | `/` | create; auto-mints `integration_secret` (`whsec_…`), returned once |
| PATCH | `/:id` | update config / rotate `apiToken` (24h previous-token window) / toggle `active` |
| DELETE | `/:id` | soft-delete (`active=false`) |
| POST | `/:id/test` | run adapter `healthcheck` |
| POST | `/:id/rotate-secret` | mint a new inbound HMAC secret |
| POST | `/:id/confirm-prod-deploy` | release the prod deploy gate |
| GET | `/:id/deliveries` | last 50 delivery rows |
| POST | `/:id/deliveries/:deliveryId/retry` | replay a delivery |
| GET | `/mcp-preview` | preview the injected MCP config |
| GET | `/integrations/status` | composed read-only status hub (GitHub/Coolify/runners/postgres/MCP/Sentry/Claude cards) |

Connection-level router, all under `/api/integration-connections` (`integrationConnectionsRoutes`, mounted in `src/index.ts:360`) — owner-scoped connections that can be shared into projects via bindings:

| Method | Path | Use |
|--------|------|-----|
| GET | `/` | list owned connections |
| POST | `/` | create a connection (supports `orgId` → org-owned) |
| POST | `/:id/bindings` | bind an existing connection to a project (the "share a connection" UX) |
| GET | `/:id/bindings` | list a connection's bindings |
| POST | `/:id/test` | test the connection |
| PATCH | `/:id` | update |
| DELETE | `/:id` | delete |

## Adding an adapter

1. Add the provider to `IntegrationProvider` in `types.ts` — and add the matching discriminated-union arm in `packages/contracts/src/integrations.ts` (the contract union is coupled to the core enum; both must list the new provider).
2. Create `integrations/<provider>/` with `client.ts` (HTTP), `types.ts` (config + secrets shapes), `adapter.ts` implementing `IntegrationAdapter`.
3. Register at boot in `src/index.ts` (next to `registerCoolifyAdapter()`).
4. Inbound: add a `{ header, provider }` entry to `PROVIDER_HEADER_MAP` in `webhooks/inbound-routes.ts`; verify HMAC with `ctx.integrationSecret`.
5. Outbound on the queue: extend the worker in `queue.ts` (consumer is Coolify-specific today — generalize the job-kind switch).
6. Add a provider Zod schema in `integrations/routes.ts` (config + secrets) — config validation lives here, since the adapter has no `validateConfig`.
7. Record every call via `recordDelivery`/`updateDelivery` for audit + idempotency.

## Not yet (unshipped)

Outbound is release-hook-triggered and Coolify-only (no typed event bus, no generalized worker); no Human-Task adapter; no `validateConfig`/`pollState` hooks, webhook-secret rotation window, or payload versioning. Future work lives in [../IDEAS.md](../IDEAS.md) / issues — not here.

(Health-polling and delivery replay have *shipped*: an hourly health sweep — `integrations/health-sweep.ts`, queue `integrations-health-sweep`, cron `17 * * * *` — re-probes connections older than 30 min; delivery replay is the `POST /…/deliveries/:deliveryId/retry` route above.)
