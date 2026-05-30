import { apiClient } from '@/lib/api/client';
import type { DeviceRunnerAssignment, MyDevice } from './types';

export const deviceApi = {
  listMine: () => apiClient<MyDevice[]>('/me/devices'),

  // ISS-273 — projects assigned to this device, with per-device repo path/branch.
  listRunners: (deviceId: string) =>
    apiClient<DeviceRunnerAssignment[]>(`/devices/${deviceId}/runners`),

  rename: (id: string, name: string) =>
    apiClient<MyDevice>(`/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  revoke: (id: string) =>
    apiClient<void>(`/devices/${id}`, { method: 'DELETE' }),

  mintPairingCode: (projectId: string) =>
    apiClient<{ code: string; expiresAt: string }>(
      `/projects/${projectId}/devices/pairing-codes`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
};
