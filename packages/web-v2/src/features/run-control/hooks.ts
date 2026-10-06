"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { runControlApi } from "./api";

/** Shared run-control mutation factory: invalidate the run list + the run
 *  detail on success, toast on success/error. */
function useRunControl<T>(
  fn: (id: string) => Promise<T>,
  successMessage: string,
  followUp?: (data: T) => { title: string; description: string } | null,
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => fn(id),
    onSuccess: (data, id) => {
      qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      qc.invalidateQueries({ queryKey: ["pipeline-run", id] });
      qc.invalidateQueries({ queryKey: ["projects", "health"] });
      toast({ title: successMessage, tone: "success" });
      const extra = followUp?.(data);
      if (extra) toast({ ...extra, tone: "error" });
    },
    onError: (err) => {
      toast({ title: "Run control failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePauseRun() {
  return useRunControl((id) => runControlApi.pause(id), "Run paused");
}
export function useResumeRun() {
  return useRunControl((id) => runControlApi.resume(id), "Run resumed");
}
export function useCancelRun() {
  return useRunControl((id) => runControlApi.cancel(id), "Run cancelled", (r) =>
    r.parkRefused
      ? { title: "The issue was not put on hold", description: r.parkRefused.detail }
      : null,
  );
}
