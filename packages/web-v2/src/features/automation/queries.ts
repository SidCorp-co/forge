// The automation feature's reads: one key factory and its queryOptions. Every automation read sits
// under `['automation', projectId]`, so a write that moves a schedule, fire or report invalidates it.
import { readOf } from "@/lib/api/query-kit";
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
  standing: (projectId: string | undefined) => readOf(automationKeys.standing(projectId), () => automationApi.standing(projectId as string)),
  schedule: (projectId: string | undefined, id: string, enabled: boolean) => ({
    ...readOf(automationKeys.schedule(projectId, id), () => automationApi.schedule(projectId as string, id)),
    enabled: enabled && !!projectId && !!id,
  }),
  fire: (projectId: string | undefined, id: string) => readOf(automationKeys.fire(projectId, id), () => automationApi.fire(projectId as string, id)),
  report: (projectId: string | undefined, id: string) => readOf(automationKeys.report(projectId, id), () => automationApi.report(projectId as string, id)),
  scheduleList: (projectId: string | undefined) => readOf(automationKeys.scheduleList(projectId), () => schedulesApi.list(projectId as string)),
};
