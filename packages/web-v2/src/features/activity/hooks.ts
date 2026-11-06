import { ORG_ACTIVITY_GROUPS, type OrgActivity, type OrgActivityGroup, orgRoom } from "@forge/contracts/org-activity";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const client = useQueryClient();
  return useQuery({
    queryKey: [ORG_ACTIVITY_ROOT, orgId ?? ""],
    queryFn: async ({ queryKey }) => keepReadWaits(await activityApi.read(orgId as string), client.getQueryData<OrgActivity>(queryKey)),
    enabled: Boolean(orgId),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.refreshing ? REFRESHING_AGAIN_MS : false),
  });
}

/**
 * A fresh answer, with each project's decisions kept from the last answer that had read them, where
 * this one is still reading them (`peoplePending`). Core says such a project waits on no one only
 * because it has not read yet, never because nothing waits (VISION: state-never-lies), so the page
 * keeps what it last knew rather than emptying Waiting on you, its pins and its counts (ISS-979).
 */
export function keepReadWaits(fresh: OrgActivity, held: OrgActivity | undefined): OrgActivity {
  if (!held || !fresh.projects.some((p) => p.peoplePending)) return fresh;
  const known = new Map(held.projects.filter((p) => !p.peoplePending).map((p) => [p.projectId, p]));
  const projects = fresh.projects.map((p) => {
    const last = p.peoplePending ? known.get(p.projectId) : undefined;
    if (!last) return p;
    return { ...p, group: last.group, people: last.people, peoplePending: false, lane: { ...p.lane, waits: last.lane.waits } };
  });
  // the chips count the groups the list shows, never the groups the pending read guessed (ISS-979 round 4)
  return { ...fresh, projects, totals: totalsOf(projects) };
}

/** Projects per group, as core counts them (`activity/read.ts`), over the projects the page shows. */
export function totalsOf(projects: OrgActivity["projects"]): OrgActivity["totals"] {
  return {
    projects: projects.length,
    ...(Object.fromEntries(ORG_ACTIVITY_GROUPS.map((g) => [g, projects.filter((p) => p.group === g).length])) as Record<OrgActivityGroup, number>),
  };
}

/**
 * The root of a project's Recent list: not under {@link ORG_ACTIVITY_ROOT}, which every org frame
 * invalidates. An invalidation cancels a read in flight and starts it again, so while frames came
 * faster than Recent answered it was never answered, and the peek showed "…" (ISS-951 round 3).
 */
export const ORG_ACTIVITY_RECENT_ROOT = "org-activity-recent";

/** One project's Recent list, read once a person opens it, and again each time it is opened. */
export function useProjectRecent(orgId: string | null, projectId: string, open: boolean) {
  return useQuery({
    queryKey: [ORG_ACTIVITY_RECENT_ROOT, orgId ?? "", projectId],
    staleTime: 0,
    queryFn: () => activityApi.recent(orgId as string, projectId),
    enabled: Boolean(orgId) && open,
  });
}

/** The root of a project's cleanup row: its own, for the reason Recent has its own (ISS-1051). */
export const ORG_ACTIVITY_CLEANUP_ROOT = "org-activity-cleanup";

/** One project's debt ledger, its cleanup window and open debt: the project Dashboard's Audit line (ISS-1067). */
export function useProjectLedger(projectId: string) {
  return useQuery({ queryKey: [ORG_ACTIVITY_CLEANUP_ROOT, projectId, "ledger"], queryFn: () => activityApi.ledger(projectId) });
}

/**
 * One project's cleanup, read once its peek is open (ISS-1051): the ledger's window and open debt,
 * and its newest current report, from the two reads the project's own doors serve.
 */
export function useProjectCleanup(projectId: string, open: boolean) {
  const ledger = useQuery({
    queryKey: [ORG_ACTIVITY_CLEANUP_ROOT, projectId, "ledger"],
    staleTime: 0,
    queryFn: () => activityApi.ledger(projectId),
    enabled: open,
  });
  const reports = useQuery({
    queryKey: [ORG_ACTIVITY_CLEANUP_ROOT, projectId, "reports"],
    staleTime: 0,
    queryFn: () => activityApi.cleanupReports(projectId),
    enabled: open,
  });
  return { ledger, reports };
}
