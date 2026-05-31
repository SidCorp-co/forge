"use client";

// web-v2 feature module: schedules — React Query hooks. Keyed
// `['schedules', projectId]`; mutations invalidate the subtree on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { schedulesApi } from "./api";

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
      toast({ title: successMessage, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function useSetScheduleEnabled(projectId: string | undefined) {
  return useScheduleMutation(
    ({ id, enabled }: { id: string; enabled: boolean }) => schedulesApi.setEnabled(id, enabled),
    projectId,
    "Schedule updated",
  );
}

export function useRunSchedule(projectId: string | undefined) {
  return useScheduleMutation(
    (id: string) => schedulesApi.run(id),
    projectId,
    "Schedule triggered",
  );
}
