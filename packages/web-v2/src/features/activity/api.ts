// web-v2 feature module: activity — REST surface.
//
// Backs the cross-project Activity feed on `GET /api/chat-logs`. Omitting
// `projectSlug` yields the caller-visible cross-project view (owned + member
// projects), scoped server-side — see `packages/core/src/chat-logs/routes.ts`.
import { apiClientList } from "@/lib/api/client";
import type { ChatLogRow, QaRating, SourceFilter } from "./types";

export const ACTIVITY_PAGE_SIZE = 25;

export interface ListActivityOpts {
  source?: SourceFilter;
  intent?: string;
  qaRating?: QaRating | "";
  page?: number;
  pageSize?: number;
}

export const activityApi = {
  /**
   * `GET /api/chat-logs` — flat rows ordered newest-first + `X-Total-Count`.
   * No `projectSlug` ⇒ cross-project (workspace-tier) view.
   */
  list: ({
    source,
    intent,
    qaRating,
    page = 1,
    pageSize = ACTIVITY_PAGE_SIZE,
  }: ListActivityOpts) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (source) params.set("source", source);
    if (intent) params.set("intent", intent);
    if (qaRating) params.set("qaRating", qaRating);
    return apiClientList<ChatLogRow>(`/chat-logs?${params}`);
  },
};
