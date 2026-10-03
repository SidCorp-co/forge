import { apiClient } from "@/lib/api/client";
import type { SuggestionDecision, SuggestionListResponse, SuggestionResponse } from "./types";

const base = (projectId: string) => `/projects/${projectId}/suggestions`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const suggestionsApi = {
  /** The suggestions still waiting on one requirement. */
  waitingOn: (projectId: string, requirement: string) =>
    apiClient<SuggestionListResponse>(`${base(projectId)}?requirement=${encodeURIComponent(requirement)}&status=proposed`),
  waitingInProject: (projectId: string) => apiClient<SuggestionListResponse>(`${base(projectId)}?status=proposed`),
  decide: (projectId: string, d: SuggestionDecision) =>
    apiClient<SuggestionResponse>(`${base(projectId)}/${d.id}/${d.kind}`, post(d.kind === "reject" ? { reason: d.reason } : {})),
};
