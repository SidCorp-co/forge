"use client";

import { useQuery, } from "@tanstack/react-query";
import { automationApi } from "./api";

/** Every key the automation read model answers under; a write that moves a schedule, a fire or a report invalidates it. */
export const automationKey = (projectId: string | undefined) => ["automation", projectId] as const;

export function useAutomationStanding(projectId: string | undefined) {
  return useQuery({
    queryKey: [...automationKey(projectId), "standing"],
    queryFn: () => automationApi.standing(projectId as string),
    enabled: !!projectId,
  });
}

export function useScheduleDetail(projectId: string | undefined, scheduleId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...automationKey(projectId), "schedule", scheduleId],
    queryFn: () => automationApi.schedule(projectId as string, scheduleId),
    enabled: enabled && !!projectId && !!scheduleId,
  });
}

export function useFireDetail(projectId: string | undefined, fireId: string) {
  return useQuery({
    queryKey: [...automationKey(projectId), "fire", fireId],
    queryFn: () => automationApi.fire(projectId as string, fireId),
    enabled: !!projectId && !!fireId,
  });
}

export function useReportDetail(projectId: string | undefined, reportId: string) {
  return useQuery({
    queryKey: [...automationKey(projectId), "report", reportId],
    queryFn: () => automationApi.report(projectId as string, reportId),
    enabled: !!projectId && !!reportId,
  });
}
