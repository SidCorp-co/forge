
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commentsApi } from "./api";
import { commentKeys, commentQueries } from "./queries";
import type { CreateEntityCommentRequest, DecisionReadScope, EntityCommentScope } from "./types";

export function useEntityComments(projectId: string, scope: EntityCommentScope, ref: string) {
  return useQuery(commentQueries.list(projectId, scope, ref));
}

export function useEntityDecisions(projectId: string | undefined, scope: DecisionReadScope, ref: string | undefined) {
  return useQuery(commentQueries.decisions(projectId, scope, ref));
}

export function usePostEntityComment(projectId: string, scope: EntityCommentScope, ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntityCommentRequest) => commentsApi.post(projectId, scope, ref, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: commentKeys.decisions(projectId, scope, ref) });
      void qc.invalidateQueries({ queryKey: commentKeys.list(projectId, scope, ref) });
      void qc.invalidateQueries({ queryKey: ["requirement-decisions", projectId] });
    },
  });
}
