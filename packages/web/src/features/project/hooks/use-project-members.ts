'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export interface ProjectMemberRow {
  userId: string;
  email: string;
  role: string;
  createdAt: string;
}

export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'members'] as const,
    queryFn: () =>
      apiClient<ProjectMemberRow[]>(`/projects/${projectId}/members`),
    enabled: !!projectId,
  });
}
