import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agentApi } from './api';

export function useAgents(projectSlug: string) {
  return useQuery({
    queryKey: ['agents', projectSlug],
    queryFn: () => agentApi.getAgents(projectSlug),
    enabled: !!projectSlug,
  });
}

export function useAgentSessions(projectSlug: string) {
  return useQuery({
    queryKey: ['agent-sessions', projectSlug],
    queryFn: () => agentApi.getSessions(projectSlug),
    enabled: !!projectSlug,
  });
}

export function useDesktopStatus() {
  return useQuery({
    queryKey: ['desktop-status'],
    queryFn: () => agentApi.desktopStatus(),
    refetchInterval: 30_000,
  });
}

export function useAgentReview(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentType: string) => agentApi.startAgentReview(projectSlug, agentType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-sessions', projectSlug] });
    },
  });
}

export function useAgentReindex(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentType: string) => agentApi.startAgentReindex(projectSlug, agentType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-sessions', projectSlug] });
    },
  });
}
