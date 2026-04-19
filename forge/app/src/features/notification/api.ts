import { apiClient } from '@/lib/api-client';
import type { Notification } from './types';

export const notificationApi = {
  getAll: () =>
    apiClient<{ data: Notification[] }>('/notifications?sort=createdAt:desc&pagination[pageSize]=50'),

  unreadCount: () =>
    apiClient<{ data: { count: number } }>('/notifications/unread-count'),

  markAsRead: (id: string) =>
    apiClient<{ data: Notification }>(`/notifications/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { read: true } }),
    }),

  markAllRead: () =>
    apiClient<{ data: { updated: number } }>('/notifications/mark-all-read', {
      method: 'POST',
    }),
};
