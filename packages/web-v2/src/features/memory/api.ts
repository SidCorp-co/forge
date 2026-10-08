import type { MemoryEntriesResponse, MemoryEntryState } from "@forge/contracts/memory";
import { apiClient } from "@/lib/api/client";

export interface MemoryQuery {
  q: string;
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
  /** `GET /api/memory/entries` — the project's memory as a person reads it (MJ-1). */
  entries: (projectId: string, q: MemoryQuery) => {
    const params = new URLSearchParams({ projectId, state: q.state, limit: "100" });
    if (q.q.trim()) params.set("q", q.q.trim());
    return apiClient<MemoryEntriesResponse>(`/memory/entries?${params.toString()}`);
  },
  /** `POST /api/memory/:id/correct` — new text and the reason; the old body is kept as a revision. */
  correct: (projectId: string, id: string, body: { text: string; reason: string }) => acted(projectId, id, "correct", body),
  /** `POST /api/memory/:id/retire` — the reason; the row leaves every live read, nothing is deleted. */
  retire: (projectId: string, id: string, body: { reason: string }) => acted(projectId, id, "retire", body),
};
