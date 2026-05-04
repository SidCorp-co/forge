import { apiClient, apiClientList } from '@/lib/api/client';
import type {
  PmConfig,
  PmConfigPatch,
  PmDecision,
  PmEscalationRespond,
  PmPolicy,
  PmPolicyCreate,
  PmPolicyPatch,
} from '../types';

export const pmApi = {
  getConfig: (projectId: string) =>
    apiClient<PmConfig>(`/projects/${projectId}/pm/config`),

  updateConfig: (projectId: string, patch: PmConfigPatch) =>
    apiClient<PmConfig>(`/projects/${projectId}/pm/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  listPolicies: (projectId: string) =>
    apiClient<PmPolicy[]>(`/projects/${projectId}/pm/policies`),

  createPolicy: (projectId: string, input: PmPolicyCreate) =>
    apiClient<PmPolicy>(`/projects/${projectId}/pm/policies`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updatePolicy: (projectId: string, id: string, patch: PmPolicyPatch) =>
    apiClient<PmPolicy>(`/projects/${projectId}/pm/policies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deletePolicy: (projectId: string, id: string) =>
    apiClient<void>(`/projects/${projectId}/pm/policies/${id}`, {
      method: 'DELETE',
    }),

  listDecisions: (
    projectId: string,
    params: { page?: number; pageSize?: number; cause?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.page !== undefined) qs.set('page', String(params.page));
    if (params.pageSize !== undefined)
      qs.set('pageSize', String(params.pageSize));
    if (params.cause) qs.set('cause', params.cause);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return apiClientList<PmDecision>(
      `/projects/${projectId}/pm/decisions${suffix}`,
    );
  },

  respondToEscalation: (
    projectId: string,
    decisionId: string,
    body: PmEscalationRespond,
  ) =>
    apiClient<void>(
      `/projects/${projectId}/pm/escalations/${decisionId}/respond`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
};
