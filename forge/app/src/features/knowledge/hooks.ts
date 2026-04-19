import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { useProject } from '@/features/project/hooks';
import { agentApi } from '@/features/agent/api';
import type { KnowledgeEdge } from './types';

/** Normalize knowledgeIndex: if stored as flat KnowledgeIndex, wrap in repo-keyed map */
function normalizeKnowledgeIndex(
  raw: Record<string, any> | null | undefined,
  slug: string,
): Record<string, any> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const isFlat = 'project' in raw || 'architecture' in raw || 'domains' in raw;
  return isFlat ? { [slug]: raw } : raw;
}

export function useKnowledgeIndex(slug: string) {
  const { data, isLoading, refetch, isRefetching } = useProject(slug);
  const project = data?.data ?? null;
  return {
    knowledgeIndex: normalizeKnowledgeIndex(project?.knowledgeIndex, slug),
    knowledgeIndexedAt: project?.knowledgeIndexedAt ?? null,
    defaultDevice: project?.defaultDevice ?? null,
    projectDocId: project?.documentId ?? null,
    isLoading,
    refetch,
    isRefetching,
  };
}

export function useKnowledgeEdges(projectDocId: string | null) {
  return useQuery({
    queryKey: ['knowledge-edges', projectDocId],
    queryFn: () =>
      apiClient<{ data: KnowledgeEdge[] }>(
        `/knowledge-edges?filters[project][$eq]=${projectDocId}&pagination[pageSize]=1000`,
      ),
    enabled: !!projectDocId,
  });
}

export function useIndexCodebase(projectDocId: string | null, slug: string) {
  const [status, setStatus] = useState<'idle' | 'indexing' | 'completed' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startIndexing = useCallback(async () => {
    if (!projectDocId) return;
    setStatus('indexing');
    setError(null);
    try {
      const res = await apiClient<{ data: { sessionId: string; alreadyRunning?: boolean } }>(
        '/agent-sessions/index-codebase',
        {
          method: 'POST',
          body: JSON.stringify({ projectDocumentId: projectDocId }),
        },
      );
      const sid = res.data.sessionId;

      pollRef.current = setInterval(async () => {
        try {
          const session = await agentApi.getSession(sid);
          const sessionStatus = session.data?.status;
          if (sessionStatus === 'completed') {
            stopPolling();
            setStatus('completed');
            queryClient.invalidateQueries({ queryKey: ['projects', slug] });
          } else if (sessionStatus === 'failed') {
            stopPolling();
            setStatus('failed');
            setError('Indexing session failed');
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);
    } catch (err: any) {
      setStatus('failed');
      setError(err.message || 'Failed to start indexing');
    }
  }, [projectDocId, slug, queryClient, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  return { startIndexing, status, error, isIndexing: status === 'indexing' };
}
