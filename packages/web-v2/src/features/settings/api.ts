import { apiClient, apiClientList } from "@/lib/api/client";
import type {
  AssistantPreferences,
  CreatePatInput,
  NotificationRow,
  PatToken,
  PatTokenCreated,
  PreferenceChange,
  Preferences,
} from "./types";

export const NOTIFICATIONS_PAGE_SIZE = 25;

export const settingsApi = {
  getPreferences: () => apiClient<Preferences>(`/auth/me/preferences`),

  updatePreferences: (
    patch: Partial<
      Pick<Preferences, "theme" | "language" | "notifyOnMention" | "lastSeenWhatsNew" | "activeOrgId">
    >,
  ) =>
    apiClient<Preferences>(`/auth/me/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  getAssistantPreferences: () =>
    apiClient<Preferences & AssistantPreferences>(`/auth/preferences`),
  updateAssistantPreferences: (patch: Partial<AssistantPreferences>) =>
    apiClient<Preferences & AssistantPreferences>(`/auth/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  listPreferenceChanges: () =>
    apiClient<{ items: PreferenceChange[] }>(`/auth/preferences/changes`).then((r) => r.items),
  /** `POST /api/auth/preferences/changes/:id/restore` — 409 `PREFERENCE_CHANGE_SUPERSEDED` when a later change moved the field. */
  restorePreferenceChange: (id: string) =>
    apiClient<AssistantPreferences>(`/auth/preferences/changes/${id}/restore`, { method: "POST" }),

  /** `GET /api/pat` → `{ tokens }`. */
  listTokens: () => apiClient<{ tokens: PatToken[] }>(`/pat`),

  /** `POST /api/pat` → row + one-time `plaintext`. May 403 FRESH_AUTH_REQUIRED. */
  createToken: (input: CreatePatInput) =>
    apiClient<PatTokenCreated>(`/pat`, { method: "POST", body: JSON.stringify(input) }),

  /** `DELETE /api/pat/:id` — revoke. */
  revokeToken: (id: string) => apiClient<PatToken>(`/pat/${id}`, { method: "DELETE" }),

  /** `POST /api/auth/reauth` — refresh the fresh-auth window with the password. */
  reauth: (password: string) =>
    apiClient<{ freshAuthAt: string }>(`/auth/reauth`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  /** `GET /api/notifications` — flat rows + `X-Total-Count`. */
  listNotifications: (page = 1) =>
    apiClientList<NotificationRow>(
      `/notifications?page=${page}&pageSize=${NOTIFICATIONS_PAGE_SIZE}`,
    ),

  /** `POST /api/notifications/mark-all-read`. */
  markAllRead: () =>
    apiClient<{ updated: number }>(`/notifications/mark-all-read`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
