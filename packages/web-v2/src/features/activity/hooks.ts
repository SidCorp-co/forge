import { orgRoom } from "@forge/contracts/org-activity";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRoom } from "@/lib/ws/use-room";
import { activityApi } from "./api";

/** The root the event router invalidates on `org.activity.changed` (`lib/ws/event-router.ts`). */
export const ORG_ACTIVITY_ROOT = "org-activity";

/** How soon the page reads again while core says a project's release or decisions are still being read. */
const REFRESHING_AGAIN_MS = 3_000;

/**
 * What each project of the workspace works now and next, as core reads it (ISS-951), kept live by the
 * org's room: a move on any of its projects reads it again, so the page never polls. The last answer
 * stays on screen while it reads again; only while core says it is still reading something behind its
 * answer does the page read once more, and it stops when core says it is done.
 */
export function useOrgActivity(orgId: string | null) {
  useRoom(orgId ? orgRoom(orgId) : null);
  return useQuery({
    queryKey: [ORG_ACTIVITY_ROOT, orgId ?? ""],
    queryFn: () => activityApi.read(orgId as string),
    enabled: Boolean(orgId),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.refreshing ? REFRESHING_AGAIN_MS : false),
  });
}

/** One project's Recent list, read only once a person opens it. */
export function useProjectRecent(orgId: string | null, projectId: string, open: boolean) {
  return useQuery({
    queryKey: [ORG_ACTIVITY_ROOT, orgId ?? "", "recent", projectId],
    queryFn: () => activityApi.recent(orgId as string, projectId),
    enabled: Boolean(orgId) && open,
  });
}
