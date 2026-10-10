import { readOf } from "@/lib/api/query-kit";
import { commentsApi } from "./api";
import type { DecisionReadScope, EntityCommentScope } from "./types";

/** Every query key the comments feature reads under. */
export const commentKeys = {
  list: (projectId: string, scope: EntityCommentScope, ref: string) => ["entity-comments", projectId, scope, ref] as const,
  decisions: (projectId: string, scope: DecisionReadScope, ref: string) => ["entity-decisions", projectId, scope, ref] as const,
};

export const commentQueries = {
  /** Every comment on a requirement, workflow or feedback item, of every intent, as core lists them. */
  list: (projectId: string, scope: EntityCommentScope, ref: string) => readOf(commentKeys.list(projectId, scope, ref), () => commentsApi.list(projectId, scope, ref)),
  decisions: (projectId: string | undefined, scope: DecisionReadScope, ref: string | undefined) =>
    readOf(commentKeys.decisions(projectId ?? "", scope, ref ?? ""), () => commentsApi.list(projectId as string, scope, ref as string, "decision")),
};
