"use client";

// web-v2 feature module: memory — React Query hooks. Reads only (memory is
// system-written); the search query is enabled once a non-empty term is set.
import { useQuery } from "@tanstack/react-query";
import { type ListMemoryOpts, memoryApi } from "./api";
import type { MemorySource } from "./types";

export function useMemoryList(opts: ListMemoryOpts) {
  return useQuery({
    queryKey: ["memory", opts.projectId, "list", opts.source ?? null, opts.page ?? 1],
    queryFn: () => memoryApi.list(opts),
    enabled: !!opts.projectId,
  });
}

export function useMemorySearch(
  projectId: string,
  query: string,
  sourceFilter?: MemorySource[],
) {
  const term = query.trim();
  return useQuery({
    queryKey: ["memory", projectId, "search", term, sourceFilter ?? null],
    queryFn: () => memoryApi.search(projectId, term, sourceFilter),
    enabled: !!projectId && term.length > 0,
  });
}
