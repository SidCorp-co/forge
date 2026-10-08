import type { MemoryEntriesResponse, MemoryEntryState } from "@forge/contracts/memory";
import { apiClient } from "@/lib/api/client";

/**
 * One list of memories: those naming `cites` (a requirement or issue key, or a workflow's flow), or,
 * with `cites` null, the project's own, naming no item of it (REQ-33 BC-7).
 */
export interface ItemMemoryQuery {
  cites: string | null;
  state: MemoryEntryState;
}

const acted = (projectId: string, id: string, verb: "correct" | "retire", body: unknown) =>
  apiClient<{ id: string }>(`/memory/${encodeURIComponent(id)}/${verb}?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const memoryApi = {
  /** `POST /api/memory/verify` — "still true" for these memories: each is stamped checked now, by this person. */
  verify: (projectId: string, ids: string[]) =>
    apiClient<{ verified: { id: string; verifiedAt: string }[] }>(`/memory/verify?projectId=${encodeURIComponent(projectId)}`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  /** `GET /api/memory/entries?cites=` (or `uncited=true`) — the memories naming one item, or none, as a person reads them where they belong (REQ-33 BC-4, BC-7). */
  entries: (projectId: string, q: ItemMemoryQuery) => {
    const params = new URLSearchParams({ projectId, state: q.state, limit: "100", ...(q.cites === null ? { uncited: "true" } : { cites: q.cites }) });
    return apiClient<MemoryEntriesResponse>(`/memory/entries?${params.toString()}`);
  },
  /** `POST /api/memory/:id/correct` — new text and the reason; the old body is kept as a revision. */
  correct: (projectId: string, id: string, body: { text: string; reason: string }) => acted(projectId, id, "correct", body),
  /** `POST /api/memory/:id/retire` — the reason; the row leaves every live read, nothing is deleted. */
  retire: (projectId: string, id: string, body: { reason: string }) => acted(projectId, id, "retire", body),
};
