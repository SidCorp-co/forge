// web-v2 feature module: project-settings — REST surface. All calls go through
// the shared `apiClient` (no raw fetch). Routes verified against core for
// ISS-316. The shared `GET /api/projects/:id` detail lives in the `projects`
// feature (`projectApi.getById`) and is reused here via `useProject`.
import { apiClient } from "@/lib/api/client";
import type { ProjectDetail } from "@/features/projects/types";
import type {
  PipelineConfig,
  ProjectInvitationRow,
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

  /** `POST /api/projects/:id/archive` — soft archive (owner only). Returns the
   *  updated row with `archivedAt` set. Non-destructive (ISS-353). */
  archive: (id: string) =>
    apiClient<ProjectDetail>(`/projects/${id}/archive`, { method: "POST" }),

  /** `POST /api/projects/:id/unarchive` — clear `archivedAt` (owner only). */
  unarchive: (id: string) =>
    apiClient<ProjectDetail>(`/projects/${id}/unarchive`, { method: "POST" }),

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

  /** `PATCH /api/projects/:id/members/:userId` — change a member's role (owner only). */
  updateMemberRole: (id: string, userId: string, role: "admin" | "member") =>
    apiClient<unknown>(`/projects/${id}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  /** `GET /api/projects/:id/members/invitations` — pending invitations (owner/admin). */
  listInvitations: (id: string) =>
    apiClient<ProjectInvitationRow[]>(`/projects/${id}/members/invitations`),

  /** `DELETE /api/projects/:id/members/invitations?email=` — revoke a pending invitation. */
  revokeInvitation: (id: string, email: string) =>
    apiClient<unknown>(
      `/projects/${id}/members/invitations?email=${encodeURIComponent(email)}`,
      { method: "DELETE" },
    ),

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
