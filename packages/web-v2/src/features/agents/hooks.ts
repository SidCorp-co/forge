"use client";

import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "./api";

/** How often the fleet snapshot is re-read. */
// cm:guard POLLED, and the interval is deliberate rather than a default: no WS event carries the run ledger — `lib/ws/event-router.ts` invalidates `['agent-sessions']` and `['projects',id,'active-runners']` and nothing else — so a key under either prefix would look live and never refresh. 20s sits under the box's own 30s snapshot sweep, so the screen is at most one sweep behind rather than two.
const RUN_SESSIONS_POLL_MS = 20_000;

/** The fleet's runs for one project. Keyed `['run-sessions',projectId]`. */
export function useRunSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: ["run-sessions", projectId],
    queryFn: () => agentsApi.runSessions(projectId as string),
    enabled: !!projectId,
    refetchInterval: RUN_SESSIONS_POLL_MS,
  });
}
