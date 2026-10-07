import { apiClient } from "@/lib/api/client";
import type {
  CreateEntityCommentRequest,
  DecisionFilters,
  DecisionListResponse,
  EntityCommentListResponse,
  EntityCommentResponse,
  EntityCommentScope,
} from "./types";

const SEGMENT: Record<EntityCommentScope, string> = {
  requirement: "requirements",
  workflow: "workflows",
  feedback: "feedback",
};

const commentsOf = (projectId: string, scope: EntityCommentScope, ref: string) =>
  `/projects/${projectId}/${SEGMENT[scope]}/${encodeURIComponent(ref)}/comments`;

export const commentsApi = {
  list: (projectId: string, scope: EntityCommentScope, ref: string, intent?: "question" | "decision" | "note") =>
    apiClient<EntityCommentListResponse>(`${commentsOf(projectId, scope, ref)}${intent ? `?intent=${intent}` : ""}`),
  post: (projectId: string, scope: EntityCommentScope, ref: string, body: CreateEntityCommentRequest) =>
    apiClient<EntityCommentResponse>(commentsOf(projectId, scope, ref), { method: "POST", body: JSON.stringify(body) }),
  /** The project's decisions, newest first, narrowed by what each names (`ListDecisionsQuery`). */
  decisions: (projectId: string, query: DecisionFilters = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, String(v));
    const qs = params.toString();
    return apiClient<DecisionListResponse>(`/projects/${projectId}/decisions${qs ? `?${qs}` : ""}`);
  },
};
