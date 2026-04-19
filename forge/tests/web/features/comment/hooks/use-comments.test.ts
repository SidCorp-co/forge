import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useComments, useCreateComment } from '@/features/comment/hooks/use-comments';

vi.mock('@/features/comment/api/comment-api', () => ({
  commentApi: {
    getByIssue: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn().mockResolvedValue({ data: { id: 1 } }),
  },
}));

import { commentApi } from '@/features/comment/api/comment-api';

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

describe('useComments', () => {
  it('calls getByIssue with the correct issueId', async () => {
    renderHook(() => useComments('42'), { wrapper });

    await waitFor(() => {
      expect(commentApi.getByIssue).toHaveBeenCalledWith('42');
    });
  });

  it('does not call getByIssue when issueId is empty', () => {
    const { result } = renderHook(() => useComments(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(commentApi.getByIssue).not.toHaveBeenCalled();
  });
});

describe('useCreateComment', () => {
  it('calls create with payload and invalidates scoped comments key', async () => {
    const { result } = renderHook(() => useCreateComment('42'), { wrapper });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await result.current.mutateAsync({ body: 'Hello', issue: 'issue-doc-42' });

    expect(commentApi.create).toHaveBeenCalledWith({ body: 'Hello', issue: 'issue-doc-42' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['comments', '42'] });
  });
});
