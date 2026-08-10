"use client";

// web-v2 feature module: skill updates — React Query hooks.
//
// A run at `decided` + `gate: 'human'` is waiting on a person, and until this
// screen existed the only way to act on one was an MCP call or a raw POST — so
// a waiting run was invisible to the owner it was waiting for.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { skillUpdatesApi } from "./api";
import type { ReconcileRunSummary } from "./types";

/** Every reconcile run for the project, newest first. */
export function useReconcileRuns(projectId: string) {
  return useQuery({
    queryKey: ["reconcile-runs", projectId],
    queryFn: () => skillUpdatesApi.list(projectId).then((r) => r.runs),
  });
}

/** One run with its candidate body, rationale and verifier votes. */
export function useReconcileRun(projectId: string, runId: string | null) {
  return useQuery({
    queryKey: ["reconcile-runs", projectId, runId],
    queryFn: () => skillUpdatesApi.get(projectId, runId as string).then((r) => r.run),
    enabled: Boolean(runId),
  });
}

/** A run is waiting on a person exactly when it is `decided` at the human gate. */
export function awaitsHuman(run: ReconcileRunSummary): boolean {
  return run.status === "decided" && run.gate === "human";
}

export function useApplyReconcileRun(projectId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (runId: string) => skillUpdatesApi.apply(projectId, runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconcile-runs", projectId] });
      toast({
        title: "Update published",
        description: "Runners pick it up on their next sync.",
        tone: "success",
      });
    },
    onError: (err) =>
      toast({ title: "Publish failed", description: formatApiError(err), tone: "error" }),
  });
}

export function useRejectReconcileRun(projectId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      skillUpdatesApi.reject(projectId, runId, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reconcile-runs", projectId] });
      toast({
        title: "Update rejected",
        description: "The running skill body is unchanged.",
        tone: "success",
      });
    },
    onError: (err) =>
      toast({ title: "Reject failed", description: formatApiError(err), tone: "error" }),
  });
}
