import type { Notification } from '../types';

// TODO(notifications-port): /api/notifications is not yet mounted in
// forge/core (audit Table A). Until the endpoint lands, every notification
// call is short-circuited to an empty/no-op response so the bell + page
// don't throw 404s on every navigation. Re-enable real apiClient calls
// when forge/core mounts /api/notifications/*.
export const notificationApi = {
  getAll: async (_projectSlug?: string): Promise<{ data: Notification[] }> => ({ data: [] }),

  unreadCount: async (_projectSlug?: string): Promise<{ data: { count: number } }> => ({
    data: { count: 0 },
  }),

  markAsRead: async (_id: string): Promise<{ data: Notification | null }> => ({ data: null }),

  markAllRead: async (_projectDocumentId?: string): Promise<{ data: { updated: number } }> => ({
    data: { updated: 0 },
  }),

  delete: async (_id: string): Promise<void> => {
    /* no-op until /api/notifications/:id lands in core */
  },
};
