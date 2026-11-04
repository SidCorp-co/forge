import { orgRoom } from "@forge/contracts/org-activity";
import { useQuery } from "@tanstack/react-query";
import { useRoom } from "@/lib/ws/use-room";
import { activityApi } from "./api";

/** The root the event router invalidates on `org.activity.changed` (`lib/ws/event-router.ts`). */
export const ORG_ACTIVITY_ROOT = "org-activity";

/**
 * What each project of the workspace works now and next, as core reads it (ISS-951), kept live by the
 * org's room: a move on any of its projects reads it again, so the page never polls.
 */
export function useOrgActivity(orgId: string | null) {
  useRoom(orgId ? orgRoom(orgId) : null);
  return useQuery({
    queryKey: [ORG_ACTIVITY_ROOT, orgId ?? ""],
    queryFn: () => activityApi.read(orgId as string),
    enabled: Boolean(orgId),
  });
}
