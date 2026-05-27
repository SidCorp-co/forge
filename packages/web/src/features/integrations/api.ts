import { apiClient } from '@/lib/api/client';
import type {
  CreateIntegrationInput,
  HealthCheckResult,
  IntegrationDelivery,
  IntegrationSummary,
  UpdateIntegrationInput,
} from './types';

export const integrationsApi = {
  list: (projectId: string) =>
    apiClient<{ items: IntegrationSummary[] }>(`/projects/${projectId}/integrations`),

  create: (projectId: string, body: CreateIntegrationInput) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/projects/${projectId}/integrations`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  update: (projectId: string, id: string, body: UpdateIntegrationInput) =>
    apiClient<{ integration: IntegrationSummary }>(
      `/projects/${projectId}/integrations/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  delete: (projectId: string, id: string) =>
    apiClient<{ ok: boolean }>(`/projects/${projectId}/integrations/${id}`, {
      method: 'DELETE',
    }),

  test: (projectId: string, id: string) =>
    apiClient<HealthCheckResult>(`/projects/${projectId}/integrations/${id}/test`, {
      method: 'POST',
    }),

  confirmProdDeploy: (projectId: string, id: string) =>
    apiClient<{ confirmed: boolean; runId: string | null; integrationId: string }>(
      `/projects/${projectId}/integrations/${id}/confirm-prod-deploy`,
      { method: 'POST' },
    ),

  rotateSecret: (projectId: string, id: string) =>
    apiClient<{ integration: IntegrationSummary; integrationSecret: string }>(
      `/projects/${projectId}/integrations/${id}/rotate-secret`,
      { method: 'POST' },
    ),

  deliveries: (projectId: string, id: string) =>
    apiClient<{ items: IntegrationDelivery[] }>(
      `/projects/${projectId}/integrations/${id}/deliveries`,
    ),
};

export const integrationKeys = {
  all: (projectId: string) => ['integrations', projectId] as const,
  list: (projectId: string) => ['integrations', projectId, 'list'] as const,
  deliveries: (projectId: string, id: string) =>
    ['integrations', projectId, id, 'deliveries'] as const,
};
