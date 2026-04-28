import { apiClient } from '@/lib/api/client';
import type { Notification } from '../types';

// TODO(per-project scoping): notifications are currently user-scoped only.
// When per-project filtering is needed, callers should resolve slug → projectId
// client-side and the signatures below should accept `projectId?: string`.
export const notificationApi = {
  getAll: async (): Promise<{ data: Notification[] }> => {
    const data = await apiClient<Notification[]>('/notifications');
    return { data };
  },

  unreadCount: async (): Promise<{ data: { count: number } }> => {
    const data = await apiClient<{ count: number }>('/notifications/unread-count');
    return { data };
  },

  markAsRead: async (id: string): Promise<{ data: Notification }> => {
    const data = await apiClient<Notification>(`/notifications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ read: true }),
    });
    return { data };
  },

  markAllRead: async (projectId?: string): Promise<{ data: { updated: number } }> => {
    const data = await apiClient<{ updated: number }>('/notifications/mark-all-read', {
      method: 'POST',
      body: JSON.stringify(projectId ? { projectId } : {}),
    });
    return { data };
  },

  delete: async (id: string): Promise<void> => {
    await apiClient<void>(`/notifications/${id}`, { method: 'DELETE' });
  },
};
