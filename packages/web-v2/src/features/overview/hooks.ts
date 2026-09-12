"use client";

import { useQuery } from "@tanstack/react-query";
import { pulseApi } from "./api";

/**
 * The workspace pulse, scoped to the active organization.
 */
// cm:edge lockstep -> packages/web-v2/src/lib/ws/event-router.ts — `['pulse']` must stay in every invalidation site that carries `['attention']` or `['projects','health']`, and in the reconnect replay. That file's own guard says a key outside the invalidated prefixes stops refreshing with nothing red to say so.
export function usePulse(orgId?: string) {
  return useQuery({
    queryKey: ["pulse", orgId ?? null],
    queryFn: () => pulseApi.get(orgId),
  });
}
