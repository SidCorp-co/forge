import { apiClient } from "@/lib/api/client";
import type { Preferences } from "./types";

export const preferencesApi = {
  get: () => apiClient<Preferences>(`/auth/me/preferences`),

  update: (patch: Partial<Pick<Preferences, "theme" | "language" | "notifyOnMention" | "activeOrgId">>) =>
    apiClient<Preferences>(`/auth/me/preferences`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};
