
import { useQuery } from "@tanstack/react-query";
import { useWrite } from "@/lib/api/query-kit";
import { isUuid } from "@/lib/api/ref-bridge";
import { type ItemMemoryQuery, memoryApi } from "./api";

const MEMORY_ROOT = ["memory-entries"] as const;

/** The memories naming one item, or none; the memory read addresses a project by its uuid only, so it waits for it. */
export function useItemMemory(projectId: string, q: ItemMemoryQuery) {
  return useQuery({
    queryKey: [...MEMORY_ROOT, projectId, q.cites ?? "uncited", q.state],
    queryFn: () => memoryApi.entries(projectId, { cites: q.cites, state: q.state }),
    enabled: isUuid(projectId) && q.cites !== "",
    staleTime: 15_000,
  });
}

/** Correct, retire and verify ("still true"), each refreshing every list of this project's memory once it lands. */
export function useMemoryActs(projectId: string) {
  const touches = [[...MEMORY_ROOT, projectId]];
  const correct = useWrite((a: { id: string; text: string; reason: string }) => memoryApi.correct(projectId, a.id, { text: a.text, reason: a.reason }), { touches });
  const retire = useWrite((a: { id: string; reason: string }) => memoryApi.retire(projectId, a.id, { reason: a.reason }), { touches });
  const verify = useWrite((ids: string[]) => memoryApi.verify(projectId, ids), { touches });
  return { correct, retire, verify };
}
