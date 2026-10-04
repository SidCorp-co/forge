"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { automationApi, pmApi } from "./api";
import type { PmConfigPatch } from "./types";

export function usePmConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pm", projectId, "config"],
    queryFn: () => pmApi.getConfig(projectId as string),
    enabled: !!projectId,
  });
}

export function usePmDecisions(projectId: string | undefined, page: number, pageSize: number) {
  return useQuery({
    queryKey: ["pm", projectId, "decisions", page, pageSize],
    queryFn: () => pmApi.listDecisions(projectId as string, { page, pageSize }),
    enabled: !!projectId,
  });
}

export function useUpdatePmConfig(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: PmConfigPatch) => pmApi.updateConfig(projectId as string, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pm", projectId] });
      toast({ title: "PM configuration saved", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't save PM config", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useRunPm(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: () => pmApi.run(projectId as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pm", projectId] });
      toast({ title: "PM sweep queued", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Couldn't run the PM sweep", description: formatApiError(err), tone: "error" });
    },
  });
}

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
