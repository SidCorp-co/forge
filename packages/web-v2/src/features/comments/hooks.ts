"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commentsApi } from "./api";
import type { CreateEntityCommentRequest, DecisionFilters, EntityCommentScope } from "./types";

const decisionsKey = (projectId: string, scope: EntityCommentScope, ref: string) => ["entity-decisions", projectId, scope, ref];
const commentsKey = (projectId: string, scope: EntityCommentScope, ref: string) => ["entity-comments", projectId, scope, ref];

/** Every comment on a requirement, workflow or feedback item, of every intent, as core lists them. */
export function useEntityComments(projectId: string, scope: EntityCommentScope, ref: string) {
  return useQuery({
    queryKey: commentsKey(projectId, scope, ref),
    queryFn: () => commentsApi.list(projectId, scope, ref),
    staleTime: 15_000,
  });
}

export function useEntityDecisions(projectId: string | undefined, scope: EntityCommentScope, ref: string | undefined) {
  return useQuery({
    queryKey: decisionsKey(projectId ?? "", scope, ref ?? ""),
    queryFn: () => commentsApi.list(projectId as string, scope, ref as string, "decision"),
    enabled: Boolean(projectId && ref),
    staleTime: 15_000,
  });
}

export function usePostEntityComment(projectId: string, scope: EntityCommentScope, ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntityCommentRequest) => commentsApi.post(projectId, scope, ref, body),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: decisionsKey(projectId, scope, ref) });
      qc.invalidateQueries({ queryKey: commentsKey(projectId, scope, ref) });
      qc.invalidateQueries({ queryKey: ["project-decisions", projectId] });
      qc.invalidateQueries({ queryKey: ["requirement-decisions", projectId] });
    },
  });
}

/** The project's decisions under `filters`, keyed so a recorded decision refreshes every filtered read. */
export function useProjectDecisions(projectId: string | undefined, filters: DecisionFilters) {
  return useQuery({
    queryKey: ["project-decisions", projectId ?? "", filters],
    queryFn: () => commentsApi.decisions(projectId as string, filters),
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });
}
