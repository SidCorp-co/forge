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
  CoolifyApplication,
  CoolifyTargetIdentity,
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

  githubRepositories: (projectId: string, connectionId: string) =>
    apiClient<GitHubRepositoriesResponse>(
      `/projects/${projectId}/integrations/github/repositories?connectionId=${encodeURIComponent(connectionId)}`,
    ),

  coolifyApplications: (
    projectId: string,
    body: { integrationId: string } | { baseUrl: string; apiToken: string },
  ) =>
    apiClient<{ applications: CoolifyApplication[] }>(
      `/projects/${projectId}/integrations/coolify/applications`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** `GET .../integrations/coolify/targets?integrationId=` — the bound targets
   *  with the identity Coolify reports, `found:false` for one it cannot place. */
  coolifyTargets: (projectId: string, integrationId: string) =>
    apiClient<{ integrationId: string; targets: CoolifyTargetIdentity[] }>(
      `/projects/${projectId}/integrations/coolify/targets?integrationId=${encodeURIComponent(integrationId)}`,
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

export const integrationConnectionsApi = {
  /** `GET /api/integration-connections` — connections owned by the caller. */
  list: () => apiClient<ConnectionListResponse>(`/integration-connections`),

  /** `POST /api/integration-connections` — create a connection (201). */
  create: (body: ConnectionCreateInput) =>
    apiClient<ConnectionResponse>(`/integration-connections`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

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

  test: (id: string) =>
    apiClient<IntegrationTestResult>(`/integration-connections/${id}/test`, {
      method: "POST",
    }),


  /** `GET /api/integration-connections/:id/bindings` — every (project, env)
   *  binding fed by this connection. Used by the connection-detail drawer's
   *  "Projects using this connection" list. */
  bindings: (id: string) =>
    apiClient<ConnectionBindingsResponse>(`/integration-connections/${id}/bindings`),

  bindExisting: (id: string, body: BindExistingConnectionRequest) =>
    apiClient<{
      integration: IntegrationSummary;
      integrationSecret: string;
      health?: IntegrationTestResult | null;
    }>(`/integration-connections/${id}/bindings`, { method: "POST", body: JSON.stringify(body) }),
};
