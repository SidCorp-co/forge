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
  GitHubConnectStart,
  GitHubRepositoriesResponse,
  McpPreviewResponse,
  RocketchatRoom,
  UpdateIntegrationInput,
} from "./types";

export const integrationsApi = {
  /** `GET /api/projects/:projectId/integrations/status` — composed real status. */
  status: (projectId: string) =>
    apiClient<IntegrationsStatus>(`/projects/${projectId}/integrations/status`),

  /** `GET .../integrations/mcp-preview` — exactly what the dispatch resolvers
   *  will inject into a runner's `mcpServers` (redacted by construction). ISS-429. */
  mcpPreview: (projectId: string) =>
    apiClient<McpPreviewResponse>(`/projects/${projectId}/integrations/mcp-preview`),

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


  /** `POST .../integrations` — create with a discriminated provider body. The
   *  server probes the new integration immediately (ISS-429) and returns the
   *  result as `health` (null when the probe crashed at transport level). */
  create: (projectId: string, body: CreateIntegrationInput) =>
    apiClient<{
      integration: IntegrationSummary;
      integrationSecret: string;
      health?: IntegrationTestResult | null;
    }>(`/projects/${projectId}/integrations`, { method: "POST", body: JSON.stringify(body) }),

  /** `PATCH .../integrations/:id` — update config/secrets/active. */
  update: (projectId: string, id: string, body: UpdateIntegrationInput) =>
    apiClient<{ integration: IntegrationSummary }>(
      `/projects/${projectId}/integrations/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
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


  /** `POST .../deliveries/:deliveryId/retry` — re-enqueue with a fresh requestId
   *  (202). Server gates on `direction==='outbound' && status==='failed'`. */
  retryDelivery: (projectId: string, bindingId: string, deliveryId: string) =>
    apiClient<DeliveryRetryResponse>(
      `/projects/${projectId}/integrations/${bindingId}/deliveries/${deliveryId}/retry`,
      { method: "POST" },
    ),

  /** `POST .../integrations/github/connect` — begin the GitHub App manifest
   *  flow. Read-only on the server: it signs a state and builds the manifest,
   *  and the credential exists only once GitHub redirects to the callback. */
  githubConnect: (
    projectId: string,
    params: { org?: string; environment?: string; orgId?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params.org) qs.set("org", params.org);
    if (params.environment) qs.set("environment", params.environment);
    if (params.orgId) qs.set("orgId", params.orgId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiClient<GitHubConnectStart>(
      `/projects/${projectId}/integrations/github/connect${suffix}`,
      { method: "POST" },
    );
  },

  /** `GET .../integrations/github/repositories?connectionId=` — what the App's
   *  installations actually granted. The picker source; a project may only bind
   *  a repository that appears here. */
  githubRepositories: (projectId: string, connectionId: string) =>
    apiClient<GitHubRepositoriesResponse>(
      `/projects/${projectId}/integrations/github/repositories?connectionId=${encodeURIComponent(connectionId)}`,
    ),

  /** `POST .../integrations/rocketchat/rooms` — rooms the bot is a member of
   *  (name picker source). Pass `integrationId` to use the stored credential,
   *  or the bare credential fields from the connect form (pre-persist probe). */
  rocketchatRooms: (
    projectId: string,
    body:
      | { integrationId: string }
      | { serverUrl: string; authToken: string; userId: string },
  ) =>
    apiClient<{ rooms: RocketchatRoom[] }>(
      `/projects/${projectId}/integrations/rocketchat/rooms`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};

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

  /** `POST /api/integration-connections/:id/test` — connection-scoped
   *  healthcheck (ISS-435). The server probes through a representative active
   *  binding and persists the result onto the connection; 404 `NO_BINDING`
   *  when the connection isn't bound to any project yet. */
  test: (id: string) =>
    apiClient<IntegrationTestResult>(`/integration-connections/${id}/test`, {
      method: "POST",
    }),


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
    apiClient<{
      integration: IntegrationSummary;
      integrationSecret: string;
      health?: IntegrationTestResult | null;
    }>(`/integration-connections/${id}/bindings`, { method: "POST", body: JSON.stringify(body) }),
};
