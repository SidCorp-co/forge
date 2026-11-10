import type { ProjectHome } from "@forge/contracts/project-home";
import { apiClient } from "@/lib/api/client";

export const projectHomeApi = {
  /** Every figure the project home draws, in one request, with days counted in `tz`. */
  read: (projectId: string, tz: string) => apiClient<ProjectHome>(`/projects/${encodeURIComponent(projectId)}/home?tz=${encodeURIComponent(tz)}`),
};
