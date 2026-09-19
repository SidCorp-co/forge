"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectRoom } from "@/lib/ws/rooms";
import { useRooms } from "@/lib/ws/use-room";
import { operatorApi } from "./api";
import type { OperatorWhoami, OperatorWindow, OperatorWorkspaceSort } from "./types";

/** Weeks of signup history the adoption curve draws. */
export const ADOPTION_WEEKS = 12;

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

export function useOperatorLiveRooms(projectIds: readonly string[]): void {
  const rooms = useMemo(() => projectIds.map(projectRoom).sort(), [projectIds]);
  useRooms(rooms);
}
