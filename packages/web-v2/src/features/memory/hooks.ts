"use client";

// web-v2 feature module: memory — React Query hooks.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ListCandidatesOpts, type ListMemoryOpts, memoryCandidatesApi, memoryApi } from "./api";
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

export function useMemoryCandidates(opts: ListCandidatesOpts) {
  return useQuery({
    queryKey: ["memory", opts.projectId, "candidates", opts.page ?? 1],
    queryFn: () => memoryCandidatesApi.list(opts),
    enabled: !!opts.projectId,
  });
}

export function useReviewCandidate(projectId: string) {
  const qc = useQueryClient();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["memory", projectId, "candidates"] });

  const accept = useMutation({
    mutationFn: (id: string) => memoryCandidatesApi.accept(id),
    onSuccess: invalidate,
  });

  const reject = useMutation({
    mutationFn: (id: string) => memoryCandidatesApi.reject(id),
    onSuccess: invalidate,
  });

  return { accept, reject };
}
