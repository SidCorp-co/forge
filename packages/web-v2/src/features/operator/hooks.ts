"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectRoom } from "@/lib/ws/rooms";
import { useRooms } from "@/lib/ws/use-room";
import { operatorApi } from "./api";
import type { OperatorWhoami, OperatorWindow, OperatorWorkspaceSort } from "./types";

/** Weeks of signup history the adoption curve draws. */
export const ADOPTION_WEEKS = 12;

// cm:edge contract -> packages/web-v2/src/lib/ws/event-router.ts — routeEvent invalidates the ["admin","ops"] PREFIX on pipeline_run.status_changed and every job.* event; a key that does not start with these two segments is one the live updates silently no-op on
const opsKey = (...rest: (string | number)[]) => ["admin", "ops", ...rest] as const;

/** `initialData` is the verdict the RSC gate already resolved for this render
 *  (app/admin/layout.tsx), so a cold load costs no second round-trip and the
 *  rail paints with the page instead of flashing a skeleton. */
export function useOperatorWhoami(initialData?: OperatorWhoami) {
  return useQuery({
    queryKey: ["operator", "whoami"],
    queryFn: operatorApi.whoami,
    staleTime: 60_000,
    retry: false,
    initialData,
  });
}

export function useOperatorOverview(window: OperatorWindow) {
  return useQuery({
    queryKey: opsKey("overview", window),
    queryFn: () => operatorApi.overview(window),
  });
}

export function useOperatorAlerts() {
  return useQuery({
    queryKey: opsKey("alerts"),
    queryFn: operatorApi.alerts,
  });
}

export function useOperatorAdoption() {
  return useQuery({
    queryKey: opsKey("adoption", ADOPTION_WEEKS),
    queryFn: () => operatorApi.adoption(ADOPTION_WEEKS),
  });
}

export function useOperatorWorkspaces(window: OperatorWindow, sort: OperatorWorkspaceSort) {
  return useQuery({
    queryKey: opsKey("workspaces", window, sort),
    queryFn: () => operatorApi.workspaces(window, sort),
  });
}

/**
 * The A2 reap. Invalidating the whole `['admin','ops']` prefix rather than the
 * alert query alone is deliberate: cancelling a job moves the in-flight KPI and
 * the success-rate glance too, and the WS event that would refresh them arrives
 * only if the socket is up.
 */
export function useReapJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => operatorApi.reapJob(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "ops"] });
      qc.invalidateQueries({ queryKey: ["jobs", "list"] });
    },
  });
}

/**
 * Join the WS room of every project on the deployment, so a run changing status
 * anywhere reaches this screen. `pipeline_run.status_changed` publishes to
 * `projectRoom(projectId)` and nowhere else — there is no cross-tenant ops room
 * to subscribe to instead, and ISS-649 chose to reuse the event rather than add
 * one.
 */
// cm:edge contract -> packages/core/src/ws/server.ts — canSubscribe admits a `project:` room on project role OR the ADMIN_EMAILS allow-list; without that second arm every room here beyond the operator's own memberships answers subscribe.denied and this hook goes quiet without saying so
export function useOperatorLiveRooms(projectIds: readonly string[]): void {
  const rooms = useMemo(() => projectIds.map(projectRoom).sort(), [projectIds]);
  useRooms(rooms);
}
