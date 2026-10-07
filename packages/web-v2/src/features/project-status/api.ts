import type { ProjectStatus } from "@forge/contracts/project-status";
import { apiClient } from "@/lib/api/client";

export const projectStatusApi = {
  read: (projectId: string, days: number) => apiClient<ProjectStatus>(`/projects/${encodeURIComponent(projectId)}/status?days=${days}`),
};
