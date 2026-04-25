import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { knowledgeApi } from '../api';
import type { KnowledgeEdgeInput, KnowledgeIngestDocument } from '../types';

const edgesKey = (projectId: string | undefined) => ['knowledge-edges', projectId] as const;

export function useKnowledgeEdges(projectId: string | undefined) {
  return useQuery({
    queryKey: edgesKey(projectId),
    queryFn: () => knowledgeApi.listEdges(projectId as string),
    enabled: !!projectId,
  });
}

export function useCreateKnowledgeEdge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeEdgeInput) => knowledgeApi.createEdge(input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: edgesKey(vars.projectId) });
    },
  });
}

export function useDeleteKnowledgeEdge(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteEdge(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: edgesKey(projectId) });
    },
  });
}

export function useIngestKnowledge(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documents: KnowledgeIngestDocument[]) =>
      knowledgeApi.ingest(projectId as string, documents),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: edgesKey(projectId) });
    },
  });
}
