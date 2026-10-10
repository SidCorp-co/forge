"use client";

import { useQuery } from "@tanstack/react-query";
import { automationQueries } from "./queries";

/** Every key the automation read model answers under; a write that moves a schedule, a fire or a report invalidates it. */

export function useAutomationStanding(projectId: string | undefined) {
  return useQuery(automationQueries.standing(projectId));
}

export function useScheduleDetail(projectId: string | undefined, scheduleId: string, enabled: boolean) {
  return useQuery(automationQueries.schedule(projectId, scheduleId, enabled));
}

export function useFireDetail(projectId: string | undefined, fireId: string) {
  return useQuery(automationQueries.fire(projectId, fireId));
}

export function useReportDetail(projectId: string | undefined, reportId: string) {
  return useQuery(automationQueries.report(projectId, reportId));
}
