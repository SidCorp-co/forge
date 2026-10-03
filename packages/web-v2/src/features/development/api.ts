import type { DevelopmentOverview } from "@forge/contracts/development-overview";
import { apiClient } from "@/lib/api/client";

export const developmentApi = {
  overview: (projectId: string) => apiClient<DevelopmentOverview>(`/projects/${projectId}/development/overview`),
};
