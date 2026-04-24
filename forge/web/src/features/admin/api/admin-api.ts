import { apiClient, apiClientList } from '@/lib/api/client';
import type {
  AdminAuditRow,
  AdminDeviceRow,
  AdminProjectRow,
  AdminUserRow,
  AdminWhoami,
} from '../types';

export interface PaginatedParams {
  limit?: number;
  offset?: number;
}

export interface AdminUsersParams extends PaginatedParams {
  q?: string;
}

export interface AdminProjectsParams extends PaginatedParams {
  q?: string;
}

export interface AdminDevicesParams extends PaginatedParams {
  status?: 'online' | 'offline' | 'revoked';
}

export interface AdminAuditParams extends PaginatedParams {
  action?: string;
  actorId?: string;
  since?: string;
}

function qs(params: Record<string, unknown> | object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

export const adminApi = {
  whoami: () => apiClient<AdminWhoami>('/admin/whoami'),

  users: (params: AdminUsersParams = {}) =>
    apiClientList<AdminUserRow>(`/admin/users?${qs(params)}`),

  projects: (params: AdminProjectsParams = {}) =>
    apiClientList<AdminProjectRow>(`/admin/projects?${qs(params)}`),

  devices: (params: AdminDevicesParams = {}) =>
    apiClientList<AdminDeviceRow>(`/admin/devices?${qs(params)}`),

  audit: (params: AdminAuditParams = {}) =>
    apiClientList<AdminAuditRow>(`/admin/audit?${qs(params)}`),
};
