// web-v2 feature module: integrations hub — REST surface. Route verified
// against `packages/core/src/integrations/routes.ts` (ISS-305).
import { apiClient } from "@/lib/api/client";
import type {
  BindExistingConnectionRequest,
  BindingListResponse,
  ConfirmProdDeployResult,
  ConnectionBindingsResponse,
  ConnectionCreateInput,
  ConnectionListResponse,
  ConnectionResponse,
  ConnectionUpdateInput,
  CreateIntegrationInput,
  DeliveryRetryResponse,
  IntegrationDelivery,
  IntegrationSummary,
  IntegrationTestResult,
  IntegrationsStatus,
  UpdateIntegrationInput,
} from "./types";

export const integrationsApi = {
  /** `GET /api/projects/:projectId/integrations/status` — composed real status. */
  status: (projectId: string) =>
    apiClient<IntegrationsStatus>(`/projects/${projectId}/integrations/status`),

  /** `GET /api/projects/:projectId/integrations` — bindings for the project
   *  (project-facing `BindingSummary` rows, projected from binding + connection). */
  list: (projectId: string) =>
    apiClient<BindingListResponse>(`/projects/${projectId}/integrations`),

  /** `POST /api/projects/:projectId/integrations/:id/test` — validate the key. */
  test: (projectId: string, id: string) =>
    apiClient<IntegrationTestResult>(`/projects/${projectId}/integrations/${id}/test`, {
      method: "POST",
    }),

  /** `DELETE /api/projects/:projectId/integrations/:id` — soft-delete (active=false). */
  remove: (projectId: string, id: string) =>
    apiClient<{ ok: boolean }>(`/projects/${projectId}/integrations/${id}`, {
      method: "DELETE",
    }),

  // === ISS-395 — generic provider CRUD (Coolify + Epodsystem) ===

  /** `POST .../integrations` — create with a discriminated provider body. */
  create: (projectId: string, body: CreateIntegrationInput) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/projects/${projectId}/integrations`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** `PATCH .../integrations/:id` — update config/secrets/active. */
  update: (projectId: string, id: string, body: UpdateIntegrationInput) =>
    apiClient<{ integration: IntegrationSummary }>(
      `/projects/${projectId}/integrations/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  /** `POST .../rotate-secret` — mint a new HMAC webhook secret (returned once). */
  rotateSecret: (projectId: string, id: string) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/projects/${projectId}/integrations/${id}/rotate-secret`,
      { method: "POST" },
    ),

  /** `POST .../confirm-prod-deploy` — release the prod deploy gate. */
  confirmProdDeploy: (projectId: string, id: string) =>
    apiClient<ConfirmProdDeployResult>(
      `/projects/${projectId}/integrations/${id}/confirm-prod-deploy`,
      { method: "POST" },
    ),

  /** `GET .../deliveries` — recent inbound/outbound webhook deliveries. */
  deliveries: (projectId: string, id: string) =>
    apiClient<{ items: IntegrationDelivery[] }>(
      `/projects/${projectId}/integrations/${id}/deliveries`,
    ),

  // === ISS-408 / F3 — re-dispatch a failed outbound delivery ===

  /** `POST .../deliveries/:deliveryId/retry` — re-enqueue with a fresh requestId
   *  (202). Server gates on `direction==='outbound' && status==='failed'`. */
  retryDelivery: (projectId: string, bindingId: string, deliveryId: string) =>
    apiClient<DeliveryRetryResponse>(
      `/projects/${projectId}/integrations/${bindingId}/deliveries/${deliveryId}/retry`,
      { method: "POST" },
    ),
};

// === ISS-401/C — owner-scoped connection CRUD ===
// Connections are the credential, owned by the authenticated principal (NOT a
// project) — these routes carry NO `:projectId` and the list is scoped server-
// side by the auth `userId`. Secrets are write-only inputs; responses only ever
// carry `hasSecrets`. `apiClient` injects the bearer token (never raw fetch).
export const integrationConnectionsApi = {
  /** `GET /api/integration-connections` — connections owned by the caller. */
  list: () => apiClient<ConnectionListResponse>(`/integration-connections`),

  /** `POST /api/integration-connections` — create a connection (201). */
  create: (body: ConnectionCreateInput) =>
    apiClient<ConnectionResponse>(`/integration-connections`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** `PATCH /api/integration-connections/:id` — update displayName/config/secrets/active. */
  update: (id: string, body: ConnectionUpdateInput) =>
    apiClient<ConnectionResponse>(`/integration-connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** `DELETE /api/integration-connections/:id` — soft-delete (active=false). */
  remove: (id: string) =>
    apiClient<{ ok: boolean }>(`/integration-connections/${id}`, {
      method: "DELETE",
    }),

  // === ISS-408 / F3 — bindings for a connection + bind-existing flow ===

  /** `GET /api/integration-connections/:id/bindings` — every (project, env)
   *  binding fed by this connection. Used by the connection-detail drawer's
   *  "Projects using this connection" list. */
  bindings: (id: string) =>
    apiClient<ConnectionBindingsResponse>(`/integration-connections/${id}/bindings`),

  /** `POST /api/integration-connections/:id/bindings` — bind an EXISTING
   *  connection to a project+env (no secrets in the request — the connection
   *  already holds the credential). Returns 201 with `{ integration,
   *  integrationSecret }`; the freshly minted inbound HMAC `integrationSecret`
   *  is shown exactly once (matches the rotate-secret pattern). */
  bindExisting: (id: string, body: BindExistingConnectionRequest) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/integration-connections/${id}/bindings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};
