import { queryOptions } from "@tanstack/react-query";
import { commentsApi } from "./api";
import type { DecisionReadScope, EntityCommentScope } from "./types";

/** Every query key the comments feature reads under. */
export const commentKeys = {
  list: (projectId: string, scope: EntityCommentScope, ref: string) => ["entity-comments", projectId, scope, ref] as const,
  decisions: (projectId: string, scope: DecisionReadScope, ref: string) => ["entity-decisions", projectId, scope, ref] as const,
};

export const commentQueries = {
  /** Every comment on a requirement, workflow or feedback item, of every intent, as core lists them. */
  list: (projectId: string, scope: EntityCommentScope, ref: string) =>
    queryOptions({
      queryKey: commentKeys.list(projectId, scope, ref),
      queryFn: () => commentsApi.list(projectId, scope, ref),
      staleTime: 15_000,
    }),
  decisions: (projectId: string | undefined, scope: DecisionReadScope, ref: string | undefined) =>
    queryOptions({
      queryKey: commentKeys.decisions(projectId ?? "", scope, ref ?? ""),
      queryFn: () => commentsApi.list(projectId as string, scope, ref as string, "decision"),
      enabled: Boolean(projectId && ref),
      staleTime: 15_000,
    }),
};
