import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agentApi, type Agent } from '../api';

export function useAgents(projectSlug: string) {
  return useQuery({
    queryKey: ['agents', projectSlug],
    queryFn: () => agentApi.getAgents(projectSlug),
    enabled: !!projectSlug,
    select: (res) => res.data || [],
  });
}

export function useUpdateAgent(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Agent> }) =>
      agentApi.updateAgent(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectSlug] });
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
