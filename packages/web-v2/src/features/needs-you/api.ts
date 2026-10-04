import { apiClient } from "@/lib/api/client";
import type { NeedsYouResponse } from "./types";

export const needsYouApi = {
  read: (projectId: string) => apiClient<NeedsYouResponse>(`/projects/${projectId}/needs-you`),
};
