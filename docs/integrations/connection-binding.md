# Integrations: Connection / Binding model

Status: **core foundation landing** (this branch) · feature layer tracked as a Forge EPIC.

## Problem

Today one `project_integrations` row gloms together three concerns: the **credential**
(`secrets_enc`), the **project+env link** (`project_id` + `environment` + per-project
`config`), and **health/breaker** state. That blocks the two things we want:

- **Org/workspace-level sharing** — connect once, reuse across many projects. Impossible
  when the credential is welded to a single `(project, env)`.
- **A professional UX** — a connection that is rotated/reauthed in one place, with a clear
  state machine, and a delivery log — not N copies of the same key.

Forge intentionally has **no org layer** today (OWNER/MEMBER per project; the RBAC proposal
was superseded). So we make the owner a generic *principal* now and promote to org later
without a data migration.

## Model

Split the single row into two:

```
integration_connections          credential, owned by a PRINCIPAL ("the org-level thing")
  owner_type  'user' | 'org'        v1 = 'user'; add 'org' later, NO re-migration
  owner_id    uuid
  provider, display_name
  config      jsonb                 connection-scoped non-secret config
  secrets_enc bytea                 the ONE copy of the credential → rotate once
  oauth_installation_id             (future: OAuth-first connect)
  active, breaker_opened_at, last_health_status, last_health_at
        │ 1
        │ N
integration_bindings              "share this connection into a project + env"
  connection_id  → integration_connections (cascade)
  project_id     → projects (cascade)
  provider       denormalized (cheap lookup + the project/provider/env unique)
  environment    'staging' | 'prod'
  config         jsonb              per-binding overrides (e.g. coolify resourceUuid/branch)
  integration_secret                per-binding HMAC for inbound webhook verification
  active
        │ 1
        │ N
integration_deliveries.binding_id  (added nullable; cutover repoints from project_integration_id)
```

Effective config for a dispatch = `connection.config` overlaid with `binding.config`.
Secret lives only on the connection. `integration_secret` (inbound HMAC) stays per-binding
because an inbound webhook is project+env scoped.

### Why connection.id == binding.id at backfill

The migration backfills **1:1** from each existing `project_integrations` row, reusing
`pi.id` as BOTH the new `connection.id` and `binding.id`. That makes
`deliveries.binding_id := project_integration_id` a trivial, idempotent update and keeps
behaviour identical (no credential de-dup at migration time — de-dup into a shared
connection is a later, user-driven action, never a migration concern).

## Adapter capabilities → adaptive UI

The 3 providers are **two archetypes**, so the adapter declares capabilities and the UI
renders to them instead of one rigid layout:

| capability        | coolify | postman | epodsystem | meaning                                  |
|-------------------|:-------:|:-------:|:----------:|------------------------------------------|
| `canDispatch`     | ✓       |         |            | core makes outbound calls                |
| `canReceiveWebhook`| ✓      |         |            | inbound webhook handler                  |
| `injectsMcp`      |         | ✓       | ✓          | injects an `mcpServers.*` entry into the runner |
| `hasEnvironments` | ✓       |         |            | staging/prod split is meaningful         |
| `prodConfirmGate` | ✓       |         |            | prod dispatch needs human confirm        |
| `hasDeliveryLog`  | ✓       |         |            | delivery audit is meaningful (no empty box for MCP providers) |

## Migration safety

- **Additive only.** New tables + a nullable column. `project_integrations` is kept and all
  current read/dispatch paths keep using it until the cutover issue flips them. Nothing
  breaks on deploy.
- Backfill is **idempotent** (`ON CONFLICT DO NOTHING` / `WHERE binding_id IS NULL`) → safe
  to re-run.
- `INTEGRATION_MASTER_KEY` is unchanged — `secrets_enc` bytes are **copied**, not
  re-encrypted, so `assertVaultBootSafety` semantics are preserved.

## Core vs Feature split

**Core (this branch — additive, safe):**
1. `integration_connections` + `integration_bindings` tables + `deliveries.binding_id`.
2. Migration + 1:1 backfill.
3. `IntegrationCapabilities` on the adapter interface; declared on all 3 adapters.
4. `store.ts` read/CRUD helpers for connection+binding (consumed by the feature issues).
5. Contract test guarding archetype capabilities + healthcheck presence.

**Feature (Forge EPIC — depends on core):**
- A. REST cutover: owner-scoped connection CRUD + project-scoped binding CRUD; repoint
  resolvers (`postman`/`epodsystem`), `forge_*` MCP tools, inbound router, `release-coolify`
  to read via binding→connection.
- B. `packages/contracts` types for connection/binding.
- C. `packages/web` integrations feature (api/types/hooks) rework.
- D. `packages/web-v2` Integrations directory + connection detail (adaptive by capabilities) +
  per-project binding tab + delivery-log viewer + secret render-safety (ADR 0013).
- E. Fold Epodsystem (ISS-387) onto the new model; expose Postman in the web UI.
- F. Drop `project_integrations` after cutover verified; unify secret rotation; OAuth-first
  connect; owner→org principal promotion.
