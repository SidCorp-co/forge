import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSessionSummary } from '@/features/agent/api';

const { useQuerySpy, useInfiniteQuerySpy } = vi.hoisted(() => ({
  useQuerySpy: vi.fn(() => ({ data: undefined, isLoading: false })),
  useInfiniteQuerySpy: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  })),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQuerySpy(opts),
  useInfiniteQuery: (opts: unknown) => useInfiniteQuerySpy(opts),
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));

vi.mock('@/features/agent/api', () => ({
  AGENT_SESSIONS_PAGE_SIZE: 50,
  agentApi: { getSessions: vi.fn(), getSession: vi.fn(), getSessionsPage: vi.fn() },
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
  useInfiniteQuerySpy.mockClear();
});

describe('useAgentSessions', () => {
  it('uses a stable query key independent of search', () => {
    useAgentSessions('proj-1', { search: 'first' });
    useAgentSessions('proj-1', { search: 'second' });
    const [a, b] = useInfiniteQuerySpy.mock.calls.map(
      (c) => c[0] as { queryKey: unknown[] },
    );
    expect(a.queryKey).toEqual(['agent-sessions', 'proj-1', 'all']);
    expect(b.queryKey).toEqual(['agent-sessions', 'proj-1', 'all']);
  });

  it('disables the query when projectId is undefined', () => {
    useAgentSessions(undefined);
    const opts = useInfiniteQuerySpy.mock.calls[0][0] as { enabled: boolean };
    expect(opts.enabled).toBe(false);
  });

  it('filters rows by title client-side when search is set', () => {
    useAgentSessions('proj-1', { search: 'refactor' });
    const opts = useInfiniteQuerySpy.mock.calls[0][0] as {
      select: (raw: {
        pages: { items: AgentSessionSummary[]; total: number; nextPage: number | null }[];
        pageParams: number[];
      }) => AgentSessionSummary[];
    };
    const rows = [
      makeRow({ documentId: 'a', title: 'Refactor agent loop' }),
      makeRow({ documentId: 'b', title: 'Build prompt cache' }),
      makeRow({ documentId: 'c', title: 'refactor sidebar' }),
    ];
    expect(
      opts.select({
        pages: [{ items: rows, total: rows.length, nextPage: null }],
        pageParams: [1],
      }),
    ).toEqual([rows[0], rows[2]]);
  });

  it('keeps title-less optimistic stubs visible under active search', () => {
    useAgentSessions('proj-1', { search: 'refactor' });
    const opts = useInfiniteQuerySpy.mock.calls[0][0] as {
      select: (raw: {
        pages: { items: AgentSessionSummary[]; total: number; nextPage: number | null }[];
        pageParams: number[];
      }) => AgentSessionSummary[];
    };
    const stub = makeRow({ documentId: 'stub', title: '' });
    const rows = [stub, makeRow({ documentId: 'b', title: 'Build prompt cache' })];
    const out = opts.select({
      pages: [{ items: rows, total: rows.length, nextPage: null }],
      pageParams: [1],
    });
    expect(out).toContain(stub);
  });

  it('passes through refetchInterval', () => {
    useAgentSessions('proj-1', { refetchInterval: 15_000 });
    const opts = useInfiniteQuerySpy.mock.calls[0][0] as {
      refetchInterval: unknown;
    };
    expect(opts.refetchInterval).toBe(15_000);
  });

  it('returns the next page number from getNextPageParam', () => {
    useAgentSessions('proj-1');
    const opts = useInfiniteQuerySpy.mock.calls[0][0] as {
      getNextPageParam: (last: {
        items: unknown[];
        total: number;
        nextPage: number | null;
      }) => number | undefined;
    };
    expect(opts.getNextPageParam({ items: [], total: 100, nextPage: 2 })).toBe(2);
    expect(opts.getNextPageParam({ items: [], total: 100, nextPage: null })).toBeUndefined();
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
