'use client';

import { useQuery } from '@tanstack/react-query';
import {
  type AdminAuditParams,
  type AdminDevicesParams,
  type AdminProjectsParams,
  type AdminUsersParams,
  adminApi,
} from '../api/admin-api';

export const adminKeys = {
  whoami: ['admin', 'whoami'] as const,
  users: (p: AdminUsersParams) => ['admin', 'users', p] as const,
  projects: (p: AdminProjectsParams) => ['admin', 'projects', p] as const,
  devices: (p: AdminDevicesParams) => ['admin', 'devices', p] as const,
  audit: (p: AdminAuditParams) => ['admin', 'audit', p] as const,
};

export function useAdminWhoami() {
  return useQuery({
    queryKey: adminKeys.whoami,
    queryFn: adminApi.whoami,
    retry: false,
  });
}

export function useAdminUsers(params: AdminUsersParams = {}) {
  return useQuery({
    queryKey: adminKeys.users(params),
    queryFn: () => adminApi.users(params),
  });
}

export function useAdminProjects(params: AdminProjectsParams = {}) {
  return useQuery({
    queryKey: adminKeys.projects(params),
    queryFn: () => adminApi.projects(params),
  });
}

export function useAdminDevices(params: AdminDevicesParams = {}) {
  return useQuery({
    queryKey: adminKeys.devices(params),
    queryFn: () => adminApi.devices(params),
  });
}

export function useAdminAudit(params: AdminAuditParams = {}) {
  return useQuery({
    queryKey: adminKeys.audit(params),
    queryFn: () => adminApi.audit(params),
  });
}
