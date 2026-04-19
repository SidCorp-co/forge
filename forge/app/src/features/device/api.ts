import { apiClient } from '@/lib/api-client';
import type { Device } from './types';

export const deviceApi = {
  getDevices: () =>
    apiClient<{ data: Device[] }>('/devices'),

  updateDevice: (docId: string, data: Record<string, unknown>) =>
    apiClient<{ data: Device }>(`/devices/${docId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  deleteDevice: (docId: string) =>
    apiClient<{ data: { ok: boolean } }>(`/devices/${docId}`, {
      method: 'DELETE',
    }),
};
