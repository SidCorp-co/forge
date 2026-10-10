// The automation feature's reads: one key factory and its queryOptions. Every automation read sits
// under `['automation', projectId]`, so a write that moves a schedule, fire or report invalidates it.
import { queryOptions } from "@tanstack/react-query";
import { automationApi } from "./api";
import { schedulesApi } from "./schedule-api";

export const automationKeys = {
  project: (projectId: string | undefined) => ["automation", projectId] as const,
  standing: (projectId: string | undefined) => [...automationKeys.project(projectId), "standing"] as const,
  schedule: (projectId: string | undefined, id: string) => [...automationKeys.project(projectId), "schedule", id] as const,
  fire: (projectId: string | undefined, id: string) => [...automationKeys.project(projectId), "fire", id] as const,
  report: (projectId: string | undefined, id: string) => [...automationKeys.project(projectId), "report", id] as const,
  schedules: (projectId: string | undefined) => ["schedules", projectId] as const,
  scheduleList: (projectId: string | undefined) => [...automationKeys.schedules(projectId), "list"] as const,
  agentReports: (projectId: string | undefined) => ["agent-reports", projectId] as const,
};

export const automationQueries = {
  standing: (projectId: string | undefined) =>
    queryOptions({ queryKey: automationKeys.standing(projectId), queryFn: () => automationApi.standing(projectId as string), enabled: !!projectId }),
  schedule: (projectId: string | undefined, id: string, enabled: boolean) =>
    queryOptions({
      queryKey: automationKeys.schedule(projectId, id),
      queryFn: () => automationApi.schedule(projectId as string, id),
      enabled: enabled && !!projectId && !!id,
    }),
  fire: (projectId: string | undefined, id: string) =>
    queryOptions({ queryKey: automationKeys.fire(projectId, id), queryFn: () => automationApi.fire(projectId as string, id), enabled: !!projectId && !!id }),
  report: (projectId: string | undefined, id: string) =>
    queryOptions({ queryKey: automationKeys.report(projectId, id), queryFn: () => automationApi.report(projectId as string, id), enabled: !!projectId && !!id }),
  scheduleList: (projectId: string | undefined) =>
    queryOptions({ queryKey: automationKeys.scheduleList(projectId), queryFn: () => schedulesApi.list(projectId as string), enabled: !!projectId }),
};
