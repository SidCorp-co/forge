"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commentsApi } from "./api";
import type { CreateEntityCommentRequest, DecisionReadScope, EntityCommentScope } from "./types";

const decisionsKey = (projectId: string, scope: DecisionReadScope, ref: string) => ["entity-decisions", projectId, scope, ref];

export function useEntityDecisions(projectId: string | undefined, scope: DecisionReadScope, ref: string | undefined) {
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
      qc.invalidateQueries({ queryKey: ["requirement-decisions", projectId] });
    },
  });
}
