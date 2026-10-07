import type { IssueForecast, ProjectForecast, ScopeForecast } from "@forge/contracts/forecast";
import { apiClient } from "@/lib/api/client";

export const forecastApi = {
  project: (projectId: string) => apiClient<ProjectForecast>(`/projects/${projectId}/forecast`),
  issue: (projectId: string, key: string) =>
    apiClient<IssueForecast>(`/projects/${projectId}/forecast/issues/${encodeURIComponent(key)}`),
  requirement: (projectId: string, key: string) =>
    apiClient<ScopeForecast>(`/projects/${projectId}/forecast/requirements/${encodeURIComponent(key)}`),
  draftRelease: (projectId: string) => apiClient<ScopeForecast>(`/projects/${projectId}/forecast/releases/draft`),
};
