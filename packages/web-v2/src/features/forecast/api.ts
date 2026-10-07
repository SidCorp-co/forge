import type {
  ComingNextForecast,
  FeedbackForecasts,
  IssueForecast,
  ProjectForecast,
  RequirementForecasts,
  ScopeForecast,
} from "@forge/contracts/forecast";
import { apiClient } from "@/lib/api/client";

export const forecastApi = {
  project: (projectId: string) => apiClient<ProjectForecast>(`/projects/${projectId}/forecast`),
  issue: (projectId: string, key: string) =>
    apiClient<IssueForecast>(`/projects/${projectId}/forecast/issues/${encodeURIComponent(key)}`),
  requirement: (projectId: string, key: string) =>
    apiClient<ScopeForecast>(`/projects/${projectId}/forecast/requirements/${encodeURIComponent(key)}`),
  requirements: (projectId: string) => apiClient<RequirementForecasts>(`/projects/${projectId}/forecast/requirements`),
  feedback: (projectId: string) => apiClient<FeedbackForecasts>(`/projects/${projectId}/forecast/feedback`),
  draftRelease: (projectId: string) => apiClient<ScopeForecast>(`/projects/${projectId}/forecast/releases/draft`),
  comingNext: (projectId: string) => apiClient<ComingNextForecast>(`/projects/${projectId}/forecast/releases/coming`),
};
