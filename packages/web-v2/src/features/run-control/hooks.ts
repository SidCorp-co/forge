"use client";

import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatRefusal } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { type CancelRunResult, runControlApi } from "./api";

/** Shared run-control mutation factory: invalidate the run list + the run detail (and whatever read the
 *  calling screen names) on success, toast on success/error. */
function useRunControl<T>(
  fn: (id: string) => Promise<T>,
  successMessage: string,
  followUp?: (data: T) => { title: string; description: string } | null,
  alsoInvalidate: readonly QueryKey[] = [],
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => fn(id),
    onSuccess: (data, id) => {
      qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      qc.invalidateQueries({ queryKey: ["pipeline-run", id] });
      qc.invalidateQueries({ queryKey: ["projects", "health"] });
      for (const queryKey of alsoInvalidate) qc.invalidateQueries({ queryKey });
      toast({ title: successMessage, tone: "success" });
      const extra = followUp?.(data);
      if (extra) toast({ ...extra, tone: "error" });
    },
    onError: (err) => {
      toast({ title: "Run control failed", description: formatRefusal(err), tone: "error" });
    },
  });
}

export function usePauseRun() {
  return useRunControl((id) => runControlApi.pause(id), "Run paused");
}
export function useResumeRun() {
  return useRunControl((id) => runControlApi.resume(id), "Run resumed");
}
/** `alsoInvalidate` names the reads of the screen it runs on that a cancel moves. */
export function useCancelRun(alsoInvalidate: readonly QueryKey[] = []) {
  return useRunControl(
    (id) => runControlApi.cancel(id),
    "Run cancelled",
    (r) => (r.parkRefused ? { title: "The issue was not put on hold", description: parkRefusalText(r) ?? "" } : null),
    alsoInvalidate,
  );
}

/** A cancel's refused park, said by its code and detail; null when the park went through or was not asked. */
export function parkRefusalText(r: CancelRunResult | undefined): string | null {
  return r?.parkRefused ? `${r.parkRefused.code}: ${r.parkRefused.detail}` : null;
}
