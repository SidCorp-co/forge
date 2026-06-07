// web-v2 feature module: integrations hub — REST surface. Route verified
// against `packages/core/src/integrations/routes.ts` (ISS-305).
import { apiClient } from "@/lib/api/client";
import type {
  ConfirmProdDeployResult,
  CreateIntegrationInput,
  CreatePostmanInput,
  IntegrationDelivery,
  IntegrationSummary,
  IntegrationTestResult,
  IntegrationsStatus,
  UpdateIntegrationInput,
  UpdatePostmanInput,
} from "./types";

export const integrationsApi = {
  /** `GET /api/projects/:projectId/integrations/status` — composed real status. */
  status: (projectId: string) =>
    apiClient<IntegrationsStatus>(`/projects/${projectId}/integrations/status`),

  /** `GET /api/projects/:projectId/integrations` — all integration rows. */
  list: (projectId: string) =>
    apiClient<{ items: IntegrationSummary[] }>(`/projects/${projectId}/integrations`),

  /** `POST /api/projects/:projectId/integrations` — create a Postman integration. */
  createPostman: (projectId: string, input: CreatePostmanInput) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/projects/${projectId}/integrations`,
      {
        method: "POST",
        body: JSON.stringify({
          provider: "postman",
          environment: "prod",
          config: input.config,
          secrets: { apiKey: input.apiKey },
        }),
      },
    ),

  /** `PATCH /api/projects/:projectId/integrations/:id` — update config/key/active. */
  updatePostman: (projectId: string, id: string, input: UpdatePostmanInput) => {
    const body: Record<string, unknown> = {};
    if (input.config) body.config = input.config;
    if (input.apiKey) body.secrets = { apiKey: input.apiKey };
    if (input.active !== undefined) body.active = input.active;
    return apiClient<{ integration: IntegrationSummary }>(
      `/projects/${projectId}/integrations/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
  },

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
};
