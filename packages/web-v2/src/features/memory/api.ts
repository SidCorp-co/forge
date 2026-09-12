// cm:edge contract -> packages/core/src/memory/list-routes.ts — the `/memory` paths and their query params are the wire shape; a route renamed there and not here fails only at runtime, and `search-routes.ts` is the same contract one path over

import { apiClient, apiClientList } from "@/lib/api/client";
import type { MemoryRow, MemorySearchResult, MemorySource } from "./types";

export const MEMORY_PAGE_SIZE = 25;

export interface ListMemoryOpts {
  projectId: string;
  source?: MemorySource;
  page?: number;
}

export const memoryApi = {
  /** `GET /api/memory` — flat rows + `X-Total-Count`. */
  list: ({ projectId, source, page = 1 }: ListMemoryOpts) => {
    const params = new URLSearchParams({
      projectId,
      limit: String(MEMORY_PAGE_SIZE),
      offset: String((page - 1) * MEMORY_PAGE_SIZE),
    });
    if (source) params.set("source", source);
    return apiClientList<MemoryRow>(`/memory?${params}`);
  },

  /** `POST /api/memory/search` — semantic search over the project's memory. */
  search: (projectId: string, query: string, sourceFilter?: MemorySource[]) =>
    apiClient<MemorySearchResult>(`/memory/search`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        query,
        topK: 25,
        ...(sourceFilter && sourceFilter.length ? { sourceFilter } : {}),
      }),
    }),
};
