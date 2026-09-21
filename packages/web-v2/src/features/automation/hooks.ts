"use client";

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
