import { useQuery } from '@tanstack/react-query';
import { agentApi, type AgentSessionSummary } from '@/features/agent/api';
import { useMemo } from 'react';

export function usePipelineActivity(projectSlug?: string) {
  const { data, isLoading } = useQuery({
    queryKey: ['pipeline-activity', projectSlug],
    queryFn: () => agentApi.getSessions(projectSlug!),
    enabled: !!projectSlug,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const sessions = data?.data ?? [];
  const DAY_MS = 86_400_000;

  const { running, queued, recentCompleted } = useMemo(() => {
    const running: AgentSessionSummary[] = [];
    const queued: AgentSessionSummary[] = [];
    const recentCompleted: AgentSessionSummary[] = [];
    const cutoff = Date.now() - DAY_MS;

    for (const s of sessions) {
      if (s.status === 'running') running.push(s);
      else if (s.status === 'queued') queued.push(s);
      else if ((s.status === 'completed' || s.status === 'failed') && new Date(s.updatedAt).getTime() > cutoff) {
        if (recentCompleted.length < 10) recentCompleted.push(s);
      }
    }
    return { running, queued, recentCompleted };
  }, [sessions]);

  return { running, queued, recentCompleted, isLoading };
}
