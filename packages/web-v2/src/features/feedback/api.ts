import { apiClient } from "@/lib/api/client";
import type {
  CreateFeedbackRequest,
  FeedbackAction,
  FeedbackListResponse,
  FeedbackPromoteEffect,
  FeedbackResponse,
  PromoteAgentReportRequest,
} from "./types";

const base = (projectId: string) => `/projects/${projectId}/feedback`;
const one = (projectId: string, key: string) => `${base(projectId)}/${encodeURIComponent(key)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

function actionRequest(projectId: string, key: string, a: FeedbackAction): [string, RequestInit] {
  if (a.kind === "redact") return [`${one(projectId, key)}/reporter-data`, { method: "DELETE" }];
  if (a.kind === "triage") return [`${one(projectId, key)}/triage`, post(a.triage)];
  if (a.kind === "verify-ask") return [`${one(projectId, key)}/verify-ask`, post({})];
  if (a.kind === "verify") return [`${one(projectId, key)}/verify`, post(a.note ? { note: a.note } : {})];
  return [`${one(projectId, key)}/${a.kind}`, post({ reason: a.reason })];
}

export const feedbackApi = {
  list: (projectId: string) => apiClient<FeedbackListResponse>(base(projectId)),
  get: (projectId: string, key: string) => apiClient<FeedbackResponse>(one(projectId, key)),
  create: (projectId: string, body: CreateFeedbackRequest) => apiClient<FeedbackResponse>(base(projectId), post(body)),
  promote: (projectId: string, body: PromoteAgentReportRequest) =>
    apiClient<FeedbackResponse & { effect: FeedbackPromoteEffect }>(`${base(projectId)}/promote`, post(body)),
  act: (projectId: string, key: string, a: FeedbackAction) => {
    const [path, init] = actionRequest(projectId, key, a);
    return apiClient<FeedbackResponse>(path, init);
  },
};
