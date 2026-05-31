"use client";

// web-v2 feature module: automation → PM — React Query hooks. Config is keyed
// `['pm', projectId, 'config']`; decisions `['pm', projectId, 'decisions', page]`.
// The config mutation invalidates the `['pm', projectId]` subtree on success.
// (The PM backend emits no WebSocket events, so freshness relies on
// invalidate-on-mutate plus the per-page decisions query — same model as the
// sibling Schedules tab.)
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { pmApi } from "./api";
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
