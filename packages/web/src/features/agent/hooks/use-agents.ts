import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { agentApi, AGENT_SESSIONS_PAGE_SIZE, type Agent } from '../api';

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
 *
 * Search is applied client-side via `select` so the cache key stays stable
 * across keystrokes (the backend ignores the `_search` arg today). Pass
 * `refetchInterval` to drive the in-progress poll without a separate timer.
 */
export function useAgentSessions(
  projectId: string | undefined,
  opts?: { search?: string; refetchInterval?: number | false },
) {
  const search = opts?.search?.trim().toLowerCase() ?? '';
  return useInfiniteQuery({
    queryKey: ['agent-sessions', projectId, 'all'],
    queryFn: ({ pageParam }) =>
      agentApi.getSessionsPage(projectId as string, {
        page: pageParam as number,
        pageSize: AGENT_SESSIONS_PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: opts?.refetchInterval ?? false,
    select: (raw) => {
      const flat = raw.pages.flatMap((p) => p.items);
      if (!search) return flat;
      // Keep title-less optimistic stubs visible; they reconcile on refetch.
      return flat.filter((s) => !s.title || s.title.toLowerCase().includes(search));
    },
  });
}

/**
 * Single-session query, keyed by sessionId. The agent page uses this to
 * read `session.diff` when the user opens the Changes tab — React Query
 * dedupes against the cached row so tab switches do not re-fetch when warm.
 */
export function useAgentSession(
  sessionId: string | null | undefined,
  opts?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ['agent-session', sessionId],
    queryFn: () => agentApi.getSession(sessionId as string),
    enabled: !!sessionId,
    staleTime: 15_000,
    refetchInterval: opts?.refetchInterval ?? false,
    select: (res) => res.data,
  });
}
