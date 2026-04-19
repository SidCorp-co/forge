'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationApi } from '../api/notification-api';

export function useNotifications(projectSlug?: string, enabled = true) {
  return useQuery({
    queryKey: ['notifications', projectSlug],
    queryFn: () => notificationApi.getAll(projectSlug),
    enabled,
  });
}

export function useUnreadCount(projectSlug?: string) {
  return useQuery({
    queryKey: ['notifications-unread', projectSlug],
    queryFn: () => notificationApi.unreadCount(projectSlug),
    refetchInterval: 30_000,
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationApi.markAsRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectDocumentId?: string) => notificationApi.markAllRead(projectDocumentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] });
    },
  });
}
