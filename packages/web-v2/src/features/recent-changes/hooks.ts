"use client";

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
