import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useIssues, useIssue, useCreateIssue, useUpdateIssue } from '@/features/issue/hooks/use-issues';

vi.mock('@/features/issue/api/issue-api', () => ({
  issueApi: {
    getAll: vi.fn().mockResolvedValue({ data: [], meta: { pagination: { page: 1, pageSize: 10, pageCount: 1, total: 0 } } }),
    getById: vi.fn().mockResolvedValue({ data: { id: 1, title: 'Test' } }),
    create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
    update: vi.fn().mockResolvedValue({ data: { id: 1 } }),
  },
}));

import { issueApi } from '@/features/issue/api/issue-api';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.clearAllMocks();
});

describe('useIssues', () => {
  it('calls getAll with the provided params', async () => {
    renderHook(() => useIssues({ projectSlug: 'my-project' }), { wrapper });

    await waitFor(() => {
      expect(issueApi.getAll).toHaveBeenCalledWith({ projectSlug: 'my-project' });
    });
  });

  it('returns data from the API', async () => {
    (issueApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: 1, title: 'Issue 1' }],
      meta: { pagination: { page: 1, pageSize: 10, pageCount: 1, total: 1 } },
    });

    const { result } = renderHook(() => useIssues({ projectSlug: 'my-project' }), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.data).toEqual([{ id: 1, title: 'Issue 1' }]);
    });
  });

  it('does not call getAll when projectSlug is empty string', async () => {
    const { result } = renderHook(() => useIssues({ projectSlug: '' }), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(issueApi.getAll).not.toHaveBeenCalled();
  });
});

describe('useIssue', () => {
  it('calls getById with the provided id', async () => {
    renderHook(() => useIssue('abc-123'), { wrapper });

    await waitFor(() => {
      expect(issueApi.getById).toHaveBeenCalledWith('abc-123');
    });
  });

  it('uses singular query key to avoid collision with useIssues', () => {
    renderHook(() => useIssue('abc-123'), { wrapper });
    const issueCache = queryClient.getQueryCache().findAll({ queryKey: ['issue', 'abc-123'] });
    const issuesCache = queryClient.getQueryCache().findAll({ queryKey: ['issues'] });
    expect(issueCache).toHaveLength(1);
    expect(issuesCache).toHaveLength(0);
  });
});

describe('useCreateIssue', () => {
  it('calls create with payload and invalidates issues queries', async () => {
    const { result } = renderHook(() => useCreateIssue(), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await result.current.mutateAsync({
      title: 'New',
      description: 'desc',
      priority: 'medium',
      project: 'proj-doc-1',
    });

    expect(issueApi.create).toHaveBeenCalledWith({
      title: 'New',
      description: 'desc',
      priority: 'medium',
      project: 'proj-doc-1',
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['issues'] });
  });
});

describe('useUpdateIssue', () => {
  it('calls update with id and data, then invalidates issues queries', async () => {
    const { result } = renderHook(() => useUpdateIssue(), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await result.current.mutateAsync({ id: 'abc', data: { title: 'Updated' } });

    expect(issueApi.update).toHaveBeenCalledWith('abc', { title: 'Updated' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['issues'] });
  });
});
