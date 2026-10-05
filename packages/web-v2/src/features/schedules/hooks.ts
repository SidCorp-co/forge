"use client";

// web-v2 feature module: schedules — React Query hooks. Keyed
// `['schedules', projectId]`; mutations invalidate the subtree on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatRefusal } from "@/lib/api/error";
import { automationKey } from "@/features/automation/hooks";
import { schedulesApi } from "./api";
import type { ScheduleInput } from "./types";

export function useSchedules(projectId: string | undefined) {
  return useQuery({
    queryKey: ["schedules", projectId, "list"],
    queryFn: () => schedulesApi.list(projectId as string),
    enabled: !!projectId,
  });
}

function useScheduleMutation<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  projectId: string | undefined,
  successMessage: string,
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules", projectId] });
      qc.invalidateQueries({ queryKey: automationKey(projectId) });
      toast({ title: successMessage, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Refused", description: formatRefusal(err), tone: "error" });
    },
  });
}

export function useCreateSchedule(projectId: string | undefined) {
  return useScheduleMutation(
    (input: ScheduleInput) => schedulesApi.create(projectId as string, input),
    projectId,
    "Schedule created",
  );
}

/** Pause, resume, edit or take over: one PUT, which an owner may send for their own and an admin for any. */
export function useUpdateSchedule(projectId: string | undefined, successMessage = "Schedule updated") {
  return useScheduleMutation(
    ({ id, patch }: { id: string; patch: Partial<ScheduleInput> }) => schedulesApi.update(id, patch),
    projectId,
    successMessage,
  );
}

export function useDeleteSchedule(projectId: string | undefined) {
  return useScheduleMutation((id: string) => schedulesApi.remove(id), projectId, "Schedule deleted");
}

export function useRunSchedule(projectId: string | undefined) {
  return useScheduleMutation(
    (id: string) => schedulesApi.run(id),
    projectId,
    "Schedule triggered",
  );
}
