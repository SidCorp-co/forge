import { apiClient } from "@/lib/api/client";
import type { OnboardingResponse, OnboardingStateResponse, QuestionnaireAnswer, QuestionnaireResponse } from "./types";

const base = (projectId: string) => `/projects/${projectId}/onboarding`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const onboardingApi = {
  state: (projectId: string) => apiClient<OnboardingStateResponse>(base(projectId)),
  start: (projectId: string) => apiClient<OnboardingResponse>(`${base(projectId)}/start`, post({})),
  reanalyze: (projectId: string, reason?: string) =>
    apiClient<OnboardingResponse>(`${base(projectId)}/reanalyze`, post(reason ? { reason } : {})),
  join: (projectId: string) => apiClient<OnboardingResponse>(`${base(projectId)}/join`, post({})),
  /** The BA door (ISS-58): the caller's room about one requirement, opened or handed back. */
  baRoom: (projectId: string, requirement: string) =>
    apiClient<{ conversation: { id: string }; reused: boolean }>(
      `/projects/${projectId}/requirements/${encodeURIComponent(requirement)}/assistant`,
      post({}),
    ),
  /** The one submit, for an onboarding round or a BA clarification alike. */
  submit: (projectId: string, batchId: string, body: { answers: QuestionnaireAnswer[]; skip?: boolean }) =>
    apiClient<QuestionnaireResponse>(`/projects/${projectId}/questionnaires/${batchId}/answers`, post(body)),
};
