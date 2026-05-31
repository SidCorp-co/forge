// web-v2 feature module: project-settings — REST surface. All calls go through
// the shared `apiClient` (no raw fetch). Routes verified against core for
// ISS-316. The shared `GET /api/projects/:id` detail lives in the `projects`
// feature (`projectApi.getById`) and is reused here via `useProject`.
import { apiClient } from "@/lib/api/client";
import type { ProjectDetail } from "@/features/projects/types";
import type {
  PipelineConfig,
  ProjectLabel,
  ProjectMemberRow,
  ProjectUpdateInput,
} from "./types";

export const projectSettingsApi = {
  /** `PATCH /api/projects/:id` — basics + repo (owner only). Returns the row. */
  update: (id: string, patch: ProjectUpdateInput) =>
    apiClient<ProjectDetail>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** `GET /api/projects/:id/pipeline-config` → `{ pipelineConfig }`. 404
   *  `FEATURE_OFF` when the `pipelineControl` flag is disabled. */
  getPipelineConfig: (id: string) =>
    apiClient<{ pipelineConfig: PipelineConfig }>(`/projects/${id}/pipeline-config`),

  /** `PATCH /api/projects/:id/pipeline-config` — full config (owner only). */
  updatePipelineConfig: (id: string, pipelineConfig: PipelineConfig) =>
    apiClient<{ pipelineConfig: PipelineConfig }>(`/projects/${id}/pipeline-config`, {
      method: "PATCH",
      body: JSON.stringify(pipelineConfig),
    }),

  /** `GET /api/projects/:id/members` — members with emails. */
  listMembers: (id: string) =>
    apiClient<ProjectMemberRow[]>(`/projects/${id}/members`),

  /** `POST /api/projects/:id/members/invite` — invite by email (owner/admin). */
  inviteMember: (id: string, email: string, role: "admin" | "member") =>
    apiClient<unknown>(`/projects/${id}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  /** `DELETE /api/projects/:id/members/:userId` — remove a member. */
  removeMember: (id: string, userId: string) =>
    apiClient<unknown>(`/projects/${id}/members/${userId}`, { method: "DELETE" }),

  /** `GET /api/projects/:id/labels` — project labels. */
  listLabels: (id: string) => apiClient<ProjectLabel[]>(`/projects/${id}/labels`),

  /** `POST /api/projects/:id/labels` — create a label. */
  createLabel: (id: string, name: string, color: string) =>
    apiClient<ProjectLabel>(`/projects/${id}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color }),
    }),

  /** `DELETE /api/labels/:labelId` — delete a label (note: top-level route). */
  deleteLabel: (labelId: string) =>
    apiClient<unknown>(`/labels/${labelId}`, { method: "DELETE" }),
};
