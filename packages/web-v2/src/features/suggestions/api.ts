import { apiClient } from "@/lib/api/client";
import type { SuggestionAuthorAct, SuggestionDecision, SuggestionListResponse, SuggestionResponse } from "./types";

export type SuggestionTargetFilter = { requirement: string } | { feedback: string };

const base = (projectId: string) => `/projects/${projectId}/suggestions`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const suggestionsApi = {
  /** The suggestions still waiting on a person: on one requirement or feedback item, or in the whole project. */
  waiting: (projectId: string, target?: SuggestionTargetFilter) => {
    const on = target ? Object.entries(target).map(([k, v]) => `${k}=${encodeURIComponent(v)}&`).join("") : "";
    return apiClient<SuggestionListResponse>(`${base(projectId)}?${on}status=proposed`);
  },
  decide: (projectId: string, d: SuggestionDecision) =>
    apiClient<SuggestionResponse>(`${base(projectId)}/${d.id}/${d.kind}`, post(d.reason ? { reason: d.reason } : {})),
  /** Its author's own acts: a revise proposes the payload as it should read and withdraws the original; a withdraw takes it back. */
  author: (projectId: string, a: SuggestionAuthorAct) =>
    a.kind === "revise"
      ? apiClient<SuggestionResponse>(`${base(projectId)}/${a.id}/revise`, post({ payload: a.payload, reason: a.reason }))
      : apiClient<SuggestionResponse>(`${base(projectId)}/${a.id}/withdraw`, post({})),
};
