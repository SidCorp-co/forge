"use client";

// web-v2 feature module: recent-changes — React Query hook.
//
// Query-key contract (ISS-665): keyed `['recent-changes']`, the key
// `lib/ws/event-router.ts` invalidates on `issue.statusChanged` (and the other
// issue-mutating events) — mirrors the `['attention']` contract in
// `features/attention/hooks.ts`.
import { useQuery } from "@tanstack/react-query";
import { RECENT_CHANGES_LIMIT, recentChangesApi } from "./api";

export function useRecentChanges(limit: number = RECENT_CHANGES_LIMIT) {
  const q = useQuery({
    queryKey: ["recent-changes"],
    queryFn: () => recentChangesApi.list(limit),
  });

  return {
    items: q.data?.items ?? [],
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
  };
}
