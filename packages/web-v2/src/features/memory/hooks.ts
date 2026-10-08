"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isUuid } from "@/lib/api/ref-bridge";
import { type ItemMemoryQuery, memoryApi } from "./api";

const MEMORY_ROOT = ["memory-entries"] as const;

/** The memories naming one item; the memory read addresses a project by its uuid only, so it waits for it. */
export function useItemMemory(projectId: string, q: ItemMemoryQuery) {
  return useQuery({
    queryKey: [...MEMORY_ROOT, projectId, q.cites, q.state],
    queryFn: () => memoryApi.entries(projectId, q),
    enabled: isUuid(projectId) && q.cites.length > 0,
    staleTime: 15_000,
  });
}

/** Correct, retire and verify ("still true"), each refreshing every list of this project's memory once it lands. */
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
  const verify = useMutation({
    mutationFn: (ids: string[]) => memoryApi.verify(projectId, ids),
    onSuccess: refresh,
  });
  return { correct, retire, verify };
}
