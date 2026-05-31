"use client";

// web-v2 feature module: activity — React Query hooks.
//
// Query-key contract: every key starts with `['chat-logs']`. The chat-logs
// table has no per-row WS broadcast today (rows are written best-effort from
// the flag-gated chat provider in `core/src/chat/run-turn.ts`), so live refresh
// rides three signals: (1) reconnect replay — `replayOnReconnect()` in
// `lib/ws/event-router.ts` invalidates `['chat-logs']` after a dropped socket
// (ISS-314); (2) `refetchOnWindowFocus`; (3) the explicit Refresh action.
// Pushing per-row in real time would need a `chat-log.created` broadcast in
// core — recorded as a follow-up, deliberately out of scope for this UI
// migration (see the decision comment in `components/activity-screen.tsx`).
import { useQuery } from "@tanstack/react-query";
import { activityApi, type ListActivityOpts } from "./api";

/** Cross-project activity feed. Keyed `['chat-logs','list',opts]`. */
export function useActivity(opts: ListActivityOpts) {
  return useQuery({
    queryKey: ["chat-logs", "list", opts],
    queryFn: () => activityApi.list(opts),
    refetchOnWindowFocus: true,
  });
}
