import { apiClient } from '@/lib/api/client';
import type {
  CreatePatInput,
  Pat,
  PatAuditEntry,
  PatWithPlaintext,
} from './types';

export const tokenApi = {
  list: () =>
    apiClient<{ tokens: Pat[] }>('/pat').then((r) => r.tokens),

  create: (input: CreatePatInput) => {
    const body: Record<string, unknown> = { name: input.name };
    if (input.scopes) body.scopes = input.scopes;
    if (input.projectIds !== undefined) body.projectIds = input.projectIds;
    if (input.expiresAt) body.expiresAt = input.expiresAt;
    return apiClient<PatWithPlaintext>('/pat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  revoke: (id: string) =>
    apiClient<Pat>(`/pat/${id}`, { method: 'DELETE' }),

  audit: (id: string, limit?: number) => {
    const query = limit ? `?limit=${limit}` : '';
    return apiClient<{ entries: PatAuditEntry[] }>(`/pat/${id}/audit${query}`).then(
      (r) => r.entries,
    );
  },

  rotate: (id: string, expiresAt?: string | null) => {
    const body: Record<string, unknown> = {};
    if (expiresAt) body.expiresAt = expiresAt;
    return apiClient<PatWithPlaintext>(`/pat/${id}/rotate`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  reauth: (password: string) =>
    apiClient<{ stampedAt: string }>('/auth/reauth', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
};
