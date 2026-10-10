"use client";

import { type QueryKey } from "@tanstack/react-query";
import { formatRefusal } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useToastWrite } from "@/providers/toast-write";
import { type CancelRunResult, runControlApi } from "./api";

/** Shared run-control mutation factory: invalidate the run list + the run detail (and whatever read the
 *  calling screen names) on success, toast on success/error. */
function useRunControl<T>(
  fn: (id: string) => Promise<T>,
  successMessage: string,
  followUp?: (data: T) => { title: string; description: string } | null,
  alsoInvalidate: readonly QueryKey[] = [],
) {
  const { toast } = useToast();
  return useToastWrite(fn, {
    touches: (id) => [["pipeline-runs"], ["pipeline-run", id], ["projects", "health"], ...alsoInvalidate],
    said: (data) => {
      const extra = followUp?.(data);
      if (extra) toast({ ...extra, tone: "error" });
      return successMessage;
    },
    failed: "Run control failed",
    describe: formatRefusal,
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
