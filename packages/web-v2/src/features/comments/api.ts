import { apiClient } from "@/lib/api/client";
import type {
  CreateEntityCommentRequest,
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
  decisions: (projectId: string) => apiClient<DecisionListResponse>(`/projects/${projectId}/decisions`),
};
