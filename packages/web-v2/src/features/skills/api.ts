// web-v2 feature module: skills — REST surface. All calls go through the
// shared `apiClient` (no raw fetch). Routes verified against
// `packages/core/src/skills/{crud-routes,routes}.ts` for ISS-299.
import { apiClient } from "@/lib/api/client";
import type { SkillRegistration, SkillRow, SkillSyncStatus } from "./types";

export const skillsApi = {
  /** `GET /api/skills?projectId&scope=all` — global + project skills. */
  list: (projectId: string) =>
    apiClient<SkillRow[]>(`/skills?projectId=${encodeURIComponent(projectId)}&scope=all`),

  /** `POST /api/skills/sync-status` — per-skill registered stages + hash. */
  syncStatus: (projectId: string) =>
    apiClient<SkillSyncStatus[]>(`/skills/sync-status`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    }),

  /** `GET /api/projects/:projectId/skill-registrations` — per-stage bindings. */
  registrations: (projectId: string) =>
    apiClient<{ registrations: SkillRegistration[] }>(
      `/projects/${encodeURIComponent(projectId)}/skill-registrations`,
    ),

  /** `POST /api/projects/:projectId/skills/:skillId/register` — bind to stage. */
  register: (projectId: string, skillId: string, stage: string) =>
    apiClient<unknown>(
      `/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(skillId)}/register`,
      { method: "POST", body: JSON.stringify({ stage }) },
    ),

  /** `DELETE /api/projects/:projectId/skills/registrations/:stage` — clear a stage. */
  unregister: (projectId: string, stage: string) =>
    apiClient<unknown>(
      `/projects/${encodeURIComponent(projectId)}/skills/registrations/${encodeURIComponent(stage)}`,
      { method: "DELETE" },
    ),
};
