// web-v2 feature module: notifications (header bell) — REST surface.
// Workspace-global (NO projectId filter); the bell shows every notification
// for the current user. Routes verified against core notifications/routes.ts.
import { apiClient, apiClientList } from "@/lib/api/client";
import type { NotificationRow, PendingInvitation } from "./types";

/** How many rows the bell dropdown pulls. */
export const BELL_PAGE_SIZE = 20;

export const notificationsApi = {
  /** `GET /api/notifications` — flat rows (newest-first) + `X-Total-Count`. */
  list: () =>
    apiClientList<NotificationRow>(`/notifications?page=1&pageSize=${BELL_PAGE_SIZE}`),

  /** `GET /api/notifications/unread-count` → `{ count }`. */
  unreadCount: () => apiClient<{ count: number }>(`/notifications/unread-count`),

  /** `PATCH /api/notifications/:id` — mark a single notification read. */
  markRead: (id: string) =>
    apiClient<NotificationRow>(`/notifications/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ read: true }),
    }),

  /** `POST /api/notifications/mark-all-read` → `{ updated }`. */
  markAllRead: () =>
    apiClient<{ updated: number }>(`/notifications/mark-all-read`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export const invitationsApi = {
  /** `GET /api/invitations/pending` — unified project + org pending invitations. */
  pending: () => apiClient<PendingInvitation[]>(`/invitations/pending`),

  /** Accept a project or org invitation using the existing token endpoint. */
  accept: (kind: "project" | "org", token: string) =>
    apiClient<{ projectId?: string; orgId?: string; role: string }>(
      `/${kind === "org" ? "org-invitations" : "invitations"}/${token}/accept`,
      { method: "POST", body: JSON.stringify({}) },
    ),

  /** Decline a project or org invitation (sets dismissedAt). */
  decline: (kind: "project" | "org", token: string) =>
    apiClient<{ dismissed: boolean }>(
      `/${kind === "org" ? "org-invitations" : "invitations"}/${token}/decline`,
      { method: "POST", body: JSON.stringify({}) },
    ),
};
