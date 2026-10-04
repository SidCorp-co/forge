import { apiClient } from "@/lib/api/client";
import type { SuggestionListResponse, SuggestionResponse } from "@/features/suggestions/types";
import type {
  CreateFeedbackRequest,
  FeedbackAction,
  FeedbackListResponse,
  FeedbackPromoteEffect,
  FeedbackResponse,
  PromoteAgentReportRequest,
  SimilarFeedbackResponse,
} from "./types";

const base = (projectId: string) => `/projects/${projectId}/feedback`;
const one = (projectId: string, key: string) => `${base(projectId)}/${encodeURIComponent(key)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function actionRequest(projectId: string, key: string, a: FeedbackAction): [string, RequestInit] {
  if (a.kind === "redact") return [`${one(projectId, key)}/reporter-data`, { method: "DELETE" }];
  if (a.kind === "triage") return [`${one(projectId, key)}/triage`, post(a.triage)];
  if (a.kind === "route") return [`${one(projectId, key)}/route`, post(a.write)];
  if (a.kind === "verify") return [`${one(projectId, key)}/verify`, post(a.note ? { note: a.note } : {})];
  return [`${one(projectId, key)}/${a.kind}`, post({ reason: a.reason })];
}

export const feedbackApi = {
  list: (projectId: string) => apiClient<FeedbackListResponse>(base(projectId)),
  get: (projectId: string, key: string) => apiClient<FeedbackResponse>(one(projectId, key)),
  similar: (projectId: string, key: string) => apiClient<SimilarFeedbackResponse>(`${one(projectId, key)}/similar`),
  create: (projectId: string, body: CreateFeedbackRequest) => apiClient<FeedbackResponse>(base(projectId), post(body)),
  promote: (projectId: string, body: PromoteAgentReportRequest) =>
    apiClient<FeedbackResponse & { effect: FeedbackPromoteEffect }>(`${base(projectId)}/promote`, post(body)),
  act: (projectId: string, key: string, a: FeedbackAction) => {
    const [path, init] = actionRequest(projectId, key, a);
    return apiClient<FeedbackResponse>(path, init);
  },
  /** The triage suggestions an agent proposed, still waiting on a person. */
  proposals: (projectId: string, feedbackId: string) =>
    apiClient<SuggestionListResponse>(
      `/projects/${projectId}/suggestions?feedback=${encodeURIComponent(feedbackId)}&status=proposed`,
    ),
  decide: (projectId: string, suggestionId: string, decision: "accept" | "reject", reason?: string) =>
    apiClient<SuggestionResponse>(
      `/projects/${projectId}/suggestions/${suggestionId}/${decision}`,
      post(decision === "reject" ? { reason: reason ?? "" } : {}),
    ),
};
