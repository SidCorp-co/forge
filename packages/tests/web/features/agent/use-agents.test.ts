import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSessionSummary } from '@/features/agent/api';

const { useQuerySpy } = vi.hoisted(() => ({
  useQuerySpy: vi.fn(() => ({ data: undefined, isLoading: false })),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQuerySpy(opts),
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));

vi.mock('@/features/agent/api', () => ({
  agentApi: { getSessions: vi.fn(), getSession: vi.fn() },
}));

import { useAgentSession, useAgentSessions } from '@/features/agent/hooks/use-agents';

function makeRow(over: Partial<AgentSessionSummary>): AgentSessionSummary {
  return {
    documentId: 'sess',
    title: 'Hello world',
    status: 'completed',
    createdAt: '2026-05-09T00:00:00Z',
    updatedAt: '2026-05-09T00:00:00Z',
    ...over,
  } as AgentSessionSummary;
}

beforeEach(() => {
  useQuerySpy.mockClear();
});

describe('useAgentSessions', () => {
  it('uses a stable query key independent of search', () => {
    useAgentSessions('proj-1', { search: 'first' });
    useAgentSessions('proj-1', { search: 'second' });
    const [a, b] = useQuerySpy.mock.calls.map((c) => c[0] as { queryKey: unknown[] });
    expect(a.queryKey).toEqual(['agent-sessions', 'proj-1', 'all']);
    expect(b.queryKey).toEqual(['agent-sessions', 'proj-1', 'all']);
  });

  it('disables the query when projectId is undefined', () => {
    useAgentSessions(undefined);
    const opts = useQuerySpy.mock.calls[0][0] as { enabled: boolean };
    expect(opts.enabled).toBe(false);
  });

  it('filters rows by title client-side when search is set', () => {
    useAgentSessions('proj-1', { search: 'refactor' });
    const opts = useQuerySpy.mock.calls[0][0] as {
      select: (res: { data: AgentSessionSummary[] }) => AgentSessionSummary[];
    };
    const rows = [
      makeRow({ documentId: 'a', title: 'Refactor agent loop' }),
      makeRow({ documentId: 'b', title: 'Build prompt cache' }),
      makeRow({ documentId: 'c', title: 'refactor sidebar' }),
    ];
    expect(opts.select({ data: rows })).toEqual([rows[0], rows[2]]);
  });

  it('passes through refetchInterval', () => {
    useAgentSessions('proj-1', { refetchInterval: 15_000 });
    const opts = useQuerySpy.mock.calls[0][0] as { refetchInterval: unknown };
    expect(opts.refetchInterval).toBe(15_000);
  });
});

describe('useAgentSession', () => {
  it('disables the query when sessionId is null', () => {
    useAgentSession(null);
    const opts = useQuerySpy.mock.calls[0][0] as { enabled: boolean };
    expect(opts.enabled).toBe(false);
  });

  it('keys the cache on sessionId so different ids do not share data', () => {
    useAgentSession('a');
    useAgentSession('b');
    const [first, second] = useQuerySpy.mock.calls.map(
      (c) => c[0] as { queryKey: unknown[] },
    );
    expect(first.queryKey).toEqual(['agent-session', 'a']);
    expect(second.queryKey).toEqual(['agent-session', 'b']);
  });
});
