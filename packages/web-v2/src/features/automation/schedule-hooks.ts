"use client";

// web-v2 feature module: schedules — React Query hooks. Keyed
// `['schedules', projectId]`; mutations invalidate the subtree on success, and a run also on refusal.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import { formatRefusal } from "@/lib/api/error";
import { automationKey } from "@/features/automation/hooks";
import { schedulesApi } from "./schedule-api";
import type { ScheduleInput } from "./schedule-types";

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
  successMessage: ProductCopyKey,
  { refreshOnRefusal = false }: { refreshOnRefusal?: boolean } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["schedules", projectId] });
    qc.invalidateQueries({ queryKey: automationKey(projectId) });
  };
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      refresh();
      toast({ title: t(successMessage), tone: "success" });
    },
    onError: (err) => {
      if (refreshOnRefusal) refresh();
      toast({ title: t("schedules.toast.refused"), description: formatRefusal(err), tone: "error" });
    },
  });
}

export function useCreateSchedule(projectId: string | undefined) {
  return useScheduleMutation(
    (input: ScheduleInput) => schedulesApi.create(projectId as string, input),
    projectId,
    "schedules.toast.created",
  );
}

/** Pause, resume, edit or take over: one PUT, which an owner may send for their own and an admin for any. */
export function useUpdateSchedule(projectId: string | undefined, successMessage: ProductCopyKey = "schedules.toast.updated") {
  return useScheduleMutation(
    ({ id, patch }: { id: string; patch: Partial<ScheduleInput> }) => schedulesApi.update(id, patch),
    projectId,
    successMessage,
  );
}

export function useDeleteSchedule(projectId: string | undefined) {
  return useScheduleMutation((id: string) => schedulesApi.remove(id), projectId, "schedules.toast.deleted");
}

export function useRunSchedule(projectId: string | undefined) {
  return useScheduleMutation(
    (id: string) => schedulesApi.run(id),
    projectId,
    "schedules.toast.triggered",
    // a run the script failed (422) still opened a fire, so the Fires tab must read again, never keep its old list
    { refreshOnRefusal: true },
  );
}
