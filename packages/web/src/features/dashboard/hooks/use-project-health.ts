import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api';

export function useProjectHealth() {
  return useQuery({
    queryKey: ['project-health'],
    queryFn: () => dashboardApi.getProjectHealth(),
    refetchInterval: 5 * 60 * 1000, // 5 minutes
    staleTime: 2 * 60 * 1000,
    select: (res) => res ?? [],
  });
}
