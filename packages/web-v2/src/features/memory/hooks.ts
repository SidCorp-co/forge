"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type MemoryQuery, memoryApi } from "./api";

const MEMORY_ROOT = ["memory-entries"] as const;

export function useMemoryEntries(projectId: string, q: MemoryQuery) {
  return useQuery({
    queryKey: [...MEMORY_ROOT, projectId, q.state, q.q],
    queryFn: () => memoryApi.entries(projectId, q),
    staleTime: 15_000,
  });
}

/** Correct and retire, each refreshing every list of this project's memory once it lands. */
export function useMemoryActs(projectId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [...MEMORY_ROOT, projectId] });
  const correct = useMutation({
    mutationFn: (a: { id: string; text: string; reason: string }) => memoryApi.correct(projectId, a.id, { text: a.text, reason: a.reason }),
    onSuccess: refresh,
  });
  const retire = useMutation({
    mutationFn: (a: { id: string; reason: string }) => memoryApi.retire(projectId, a.id, { reason: a.reason }),
    onSuccess: refresh,
  });
  return { correct, retire };
}
