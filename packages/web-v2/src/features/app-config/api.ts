// web-v2 feature module: app-config — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Routes verified against core
// (`packages/core/src/app-config/routes.ts`, mounted at `/api/app-config`):
//   GET  /api/app-config/:projectId — any project member; returns the row OR null.
//   PUT  /api/app-config/:projectId — owner|admin; partial upsert, returns the row.
import { apiClient } from "@/lib/api/client";
import type { AppConfig, AppConfigPatch } from "./types";

export const appConfigApi = {
  /** `GET /api/app-config/:projectId` — returns the config row, or `null` when
   *  the project has no `app_config` row yet. */
  get: (projectId: string) => apiClient<AppConfig | null>(`/app-config/${projectId}`),

  /** `PUT /api/app-config/:projectId` — partial upsert (owner/admin only). */
  upsert: (projectId: string, patch: AppConfigPatch) =>
    apiClient<AppConfig>(`/app-config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
};
