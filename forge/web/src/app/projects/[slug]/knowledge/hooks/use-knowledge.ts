import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useProject } from '@/features/project/hooks/use-projects';
import { projectApi } from '@/features/project/api/project-api';
import { agentApi } from '@/features/agent/api';

/** Normalize knowledgeIndex: if stored as flat KnowledgeIndex, wrap in repo-keyed map */
function normalizeKnowledgeIndex(
  raw: Record<string, any> | null | undefined,
  slug: string,
): Record<string, any> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  // Flat KnowledgeIndex has keys like project/architecture/domains — not repo names
  const isFlat = 'project' in raw || 'architecture' in raw || 'domains' in raw;
  return isFlat ? { [slug]: raw } : raw;
}

export function useKnowledgeIndex(slug: string) {
  const { data, isLoading } = useProject(slug);
  const project = data?.data;
  return {
    knowledgeIndex: normalizeKnowledgeIndex(project?.knowledgeIndex, slug),
    knowledgeIndexedAt: project?.knowledgeIndexedAt ?? null,
    isLoading,
    project,
  };
}

export function useKnowledgeEdges(projectDocId: string | undefined) {
  return useQuery({
    queryKey: ['knowledge-edges', projectDocId],
    queryFn: () => projectApi.getKnowledgeEdges(projectDocId!),
    enabled: !!projectDocId,
  });
}

export function useCodebaseIndex(projectDocumentId: string | undefined, slug: string) {
  const [status, setStatus] = useState<'idle' | 'indexing' | 'completed' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startIndexing = useCallback(async () => {
    if (!projectDocumentId) return;
    setStatus('indexing');
    setError(null);
    try {
      const res = await projectApi.indexCodebase(projectDocumentId);
      const sid = res.data.sessionId;
      setSessionId(sid);

      if (res.data.alreadyRunning) {
        // Already running — just start polling the existing session
      }

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
          // Ignore polling errors — session might not be ready yet
        }
      }, 3000);
    } catch (err: any) {
      setStatus('failed');
      setError(err.message || 'Failed to start indexing');
    }
  }, [projectDocumentId, slug, queryClient, stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  return { startIndexing, status, error, isIndexing: status === 'indexing', sessionId };
}
