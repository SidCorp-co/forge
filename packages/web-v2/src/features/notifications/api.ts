import { apiClient, apiClientList } from "@/lib/api/client";
import type { NotificationMember, NotificationRow, PendingInvitation } from "./types";

export const BELL_PAGE_SIZE = 20;

export const notificationsApi = {
  list: () =>
    apiClientList<NotificationRow>(`/notifications?page=1&pageSize=${BELL_PAGE_SIZE}`),

  openCount: () => apiClient<{ count: number }>(`/notifications/open-count`),

  members: (id: string) => apiClient<NotificationMember[]>(`/notifications/${id}/members`),

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
