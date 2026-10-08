import { apiClient } from "@/lib/api/client";
import type { CreateEntityCommentRequest, DecisionReadScope, EntityCommentListResponse, EntityCommentResponse, EntityCommentScope } from "./types";

const SEGMENT: Record<DecisionReadScope, string> = {
  requirement: "requirements",
  workflow: "workflows",
  feedback: "feedback",
  issue: "issues",
};

const commentsOf = (projectId: string, scope: DecisionReadScope, ref: string) =>
  `/projects/${projectId}/${SEGMENT[scope]}/${encodeURIComponent(ref)}/comments`;

export const commentsApi = {
  /** What sits on one item; an issue's are read here only by intent, its thread being its own. */
  list: (projectId: string, scope: DecisionReadScope, ref: string, intent?: "question" | "decision" | "note") =>
    apiClient<EntityCommentListResponse>(`${commentsOf(projectId, scope, ref)}${intent ? `?intent=${intent}` : ""}`),
  post: (projectId: string, scope: EntityCommentScope, ref: string, body: CreateEntityCommentRequest) =>
    apiClient<EntityCommentResponse>(commentsOf(projectId, scope, ref), { method: "POST", body: JSON.stringify(body) }),
};
