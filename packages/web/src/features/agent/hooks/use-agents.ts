import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agentApi, type Agent } from '../api';

const agentsKey = (projectId: string | undefined) => ['agents', projectId] as const;

export function useAgents(projectId: string | undefined) {
  return useQuery({
    queryKey: agentsKey(projectId),
    queryFn: () => agentApi.getAgents(projectId as string),
    enabled: !!projectId,
    select: (res) => res.data || [],
  });
}

export function useCreateAgent(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Agent> & { name: string; type: string }) =>
      agentApi.createAgent({ ...data, projectId: projectId as string }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentsKey(projectId) });
    },
  });
}

export function useUpdateAgent(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Agent> }) =>
      agentApi.updateAgent(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentsKey(projectId) });
    },
  });
}

export function useDeleteAgent(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => agentApi.deleteAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentsKey(projectId) });
    },
  });
}

export function usePoSessions(projectSlug: string) {
  return useQuery({
    queryKey: ['agent-sessions', projectSlug, 'po'],
    queryFn: () => agentApi.getSessions(projectSlug, 'PO'),
    enabled: !!projectSlug,
    select: (res) =>
      (res.data || [])
        .filter((s) => s.title.startsWith('PO Review') || s.title.startsWith('PO Reindex'))
        .slice(0, 10),
  });
}

/**
 * Project-wide session feed for the agents dashboard. Returns all recent
 * sessions; the page slices per-card by matching `metadata.type` (preferred)
 * with a title-prefix fallback for older rows. Backend hook for `agentId`
 * filtering does not exist yet, so we batch one query and fan out at render.
 */
export function useAgentSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['agent-sessions', projectId, 'all'],
    queryFn: () => agentApi.getSessions(projectId as string),
    enabled: !!projectId,
    select: (res) => res.data || [],
  });
}
