'use client';

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Placeholder for features whose backend endpoint does not exist on forge/core
 * yet. Returns a React-Query-shaped result with `isError: true` so existing
 * consumers render their error branch.
 *
 * Phase 2.6 scope: out-of-scope modules (chat-logs, memory, skills, schedules,
 * antigravity, cloudflare, devices, pipeline analytics, etc.) use this to keep
 * compiling without hitting the network.
 */
export function useUnimplemented<T = unknown>(feature: string): UseQueryResult<T, Error> {
  const error = new Error(`"${feature}" is not available on forge/core yet`);
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error,
    errorUpdatedAt: Date.now(),
    failureCount: 1,
    failureReason: error,
    errorUpdateCount: 1,
    isError: true,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: true,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: false,
    refetch: async () => ({}) as never,
    status: 'error',
    fetchStatus: 'idle',
    promise: Promise.reject(error),
  } as unknown as UseQueryResult<T, Error>;
}
