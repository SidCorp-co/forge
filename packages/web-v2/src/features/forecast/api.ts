import type {
  ComingNextForecast,
  FeedbackForecasts,
  FeedbackProgress,
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
  /** One item's work, its line and its estimate or why it has none. */
  feedbackItem: (projectId: string, key: string) =>
    apiClient<FeedbackProgress>(`/projects/${projectId}/forecast/feedback/${encodeURIComponent(key)}`),
  draftRelease: (projectId: string) => apiClient<ScopeForecast>(`/projects/${projectId}/forecast/releases/draft`),
  comingNext: (projectId: string) => apiClient<ComingNextForecast>(`/projects/${projectId}/forecast/releases/coming`),
};
