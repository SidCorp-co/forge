import { apiClient } from '@/lib/api/client';
import type { Notification } from '../types';

export const notificationApi = {
  getAll: (projectSlug?: string) => {
    const params = new URLSearchParams({ 'sort': 'createdAt:desc', 'pagination[pageSize]': '50' });
    if (projectSlug) {
      params.set('filters[project][slug][$eq]', projectSlug);
    }
    return apiClient<{ data: Notification[] }>(`/notifications?${params}`);
  },

  unreadCount: (projectSlug?: string) => {
    const params = new URLSearchParams();
    if (projectSlug) {
      params.set('project', projectSlug);
    }
    return apiClient<{ data: { count: number } }>(`/notifications/unread-count?${params}`);
  },

  markAsRead: (id: string) =>
    apiClient<{ data: Notification }>(`/notifications/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { read: true } }),
    }),

  markAllRead: (projectDocumentId?: string) => {
    const params = new URLSearchParams();
    if (projectDocumentId) params.set('project', projectDocumentId);
    return apiClient<{ data: { updated: number } }>(`/notifications/mark-all-read?${params}`, {
      method: 'POST',
    });
  },

  delete: (id: string) =>
    apiClient(`/notifications/${id}`, { method: 'DELETE' }),
};
