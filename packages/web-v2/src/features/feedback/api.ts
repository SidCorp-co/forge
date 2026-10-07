import { apiClient } from "@/lib/api/client";
import type {
  CreateFeedbackRequest,
  FeedbackAction,
  FeedbackEndpointsResponse,
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
  if (a.kind === "retarget") return [`${one(projectId, key)}/retarget`, post(a.request)];
  if (a.kind === "verify-ask") return [`${one(projectId, key)}/verify-ask`, post({})];
  if (a.kind === "verify") return [`${one(projectId, key)}/verify`, post(a.note ? { note: a.note } : {})];
  return [`${one(projectId, key)}/${a.kind}`, post({ reason: a.reason })];
}

/** One thing About can name: `key` is what core is sent, `title` what the person reads and searches. */
export interface TargetChoice {
  key: string;
  title: string;
}

export const feedbackApi = {
  list: (projectId: string) => apiClient<FeedbackListResponse>(base(projectId)),
  get: (projectId: string, key: string) => apiClient<FeedbackResponse>(one(projectId, key)),
  /** What a person picks About from: the project's requirements and releases by title, its workflows by flow, read as the lists' own routes serve them. */
  choices: async (projectId: string, type: "requirement" | "workflow" | "release"): Promise<TargetChoice[]> => {
    if (type === "requirement") {
      const r = await apiClient<{ requirements: { key: string; title: string }[] }>(`/projects/${projectId}/requirements`);
      return r.requirements.map((q) => ({ key: q.key, title: q.title }));
    }
    if (type === "workflow") {
      const r = await apiClient<{ workflows: { document: { flow: string; title: string } }[] }>(`/projects/${projectId}/workflows`);
      return r.workflows.map((w) => ({ key: w.document.flow, title: w.document.title }));
    }
    const r = await apiClient<{ releases: { version: string }[] }>(`/projects/${projectId}/releases`);
    return r.releases.map((v) => ({ key: v.version, title: v.version }));
  },
  endpoints: (projectId: string) => apiClient<FeedbackEndpointsResponse>(`${base(projectId)}/endpoints`),
  create: (projectId: string, body: CreateFeedbackRequest) => apiClient<FeedbackResponse>(base(projectId), post(body)),
  promote: (projectId: string, body: PromoteAgentReportRequest) =>
    apiClient<FeedbackResponse & { effect: FeedbackPromoteEffect }>(`${base(projectId)}/promote`, post(body)),
  act: (projectId: string, key: string, a: FeedbackAction) => {
    const [path, init] = actionRequest(projectId, key, a);
    return apiClient<FeedbackResponse>(path, init);
  },
};
