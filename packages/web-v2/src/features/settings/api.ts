// web-v2 feature module: settings — REST surface. All user-scoped. Routes
// verified against core for ISS-299. PAT create/revoke require fresh auth
// (≤5 min) → core returns 403 `FRESH_AUTH_REQUIRED`; callers re-auth via
// `reauth(password)` then retry.
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
  /** `GET /api/auth/me/preferences`. */
  getPreferences: () => apiClient<Preferences>(`/auth/me/preferences`),

  /** `PATCH /api/auth/me/preferences` — partial. */
  updatePreferences: (
    patch: Partial<
      Pick<Preferences, "theme" | "language" | "notifyOnMention" | "lastSeenWhatsNew" | "activeOrgId">
    >,
  ) =>
    apiClient<Preferences>(`/auth/me/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // cm:guard the four calls below go to `/auth/preferences`, NOT `/auth/me/preferences`: the two routes are different files in core, and `/me/preferences` refuses `answerStyle` under a strict schema — a card wired to it saved nothing and listed nothing (codex F1).
  /** `GET /api/auth/preferences` — the full row, the assistant fields included (ISS-1034). */
  getAssistantPreferences: () =>
    apiClient<Preferences & AssistantPreferences>(`/auth/preferences`),
  /** `PATCH /api/auth/preferences` — the assistant fields, as the person. */
  updateAssistantPreferences: (patch: Partial<AssistantPreferences>) =>
    apiClient<Preferences & AssistantPreferences>(`/auth/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** `GET /api/auth/preferences/changes` — every write to how this person is answered. */
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
