"use client";

// web-v2 feature module: improvement-messages — React Query hooks (ISS-549).
// Keyed `['improvement-messages', projectId]`; mutations invalidate on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { improvementMessagesApi } from "./api";
import type { ImprovementMessageEntry } from "./types";

export function useImprovementMessages(projectId: string | undefined) {
  return useQuery({
    queryKey: ["improvement-messages", projectId],
    queryFn: () => improvementMessagesApi.list(projectId as string),
    enabled: !!projectId,
  });
}

export function useImprovementMessageRuns(
  projectId: string | undefined,
  scheduleId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["improvement-messages", projectId, "runs", scheduleId],
    queryFn: () => improvementMessagesApi.runs(scheduleId),
    enabled: enabled && !!projectId && !!scheduleId,
  });
}

export function useEnableImprovementMessage(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (payload: {
      projectId: string;
      templateKey: string;
      mode: "propose" | "auto";
      cron: string;
    }) => improvementMessagesApi.enable(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["improvement-messages", projectId] });
      toast({ title: "Message enabled", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Failed to enable", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useToggleImprovementMessage(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({
      scheduleId,
      enabled,
    }: {
      scheduleId: string;
      enabled: boolean;
      messageKey: string;
    }) => improvementMessagesApi.update(scheduleId, { enabled }),

    onMutate: async ({ messageKey, enabled }) => {
      await qc.cancelQueries({ queryKey: ["improvement-messages", projectId] });
      const prev = qc.getQueryData<ImprovementMessageEntry[]>([
        "improvement-messages",
        projectId,
      ]);
      qc.setQueryData<ImprovementMessageEntry[]>(
        ["improvement-messages", projectId],
        (old) =>
          old?.map((m) =>
            m.key === messageKey && m.enablement
              ? { ...m, enablement: { ...m.enablement, enabled } }
              : m,
          ),
      );
      return { prev };
    },

    onError: (err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(["improvement-messages", projectId], ctx.prev);
      }
      toast({ title: "Toggle failed", description: formatApiError(err), tone: "error" });
    },

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["improvement-messages", projectId] });
    },
  });
}

export function useUpdateImprovementMessage(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({
      scheduleId,
      patch,
    }: {
      scheduleId: string;
      patch: { mode?: "propose" | "auto"; cron?: string };
    }) => improvementMessagesApi.update(scheduleId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["improvement-messages", projectId] });
      toast({ title: "Message updated", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Update failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useRunImprovementMessage(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (scheduleId: string) => improvementMessagesApi.run(scheduleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["improvement-messages", projectId] });
      toast({ title: "Run triggered", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Run failed", description: formatApiError(err), tone: "error" });
    },
  });
}
