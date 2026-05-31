"use client";

// web-v2 feature module: pm — React Query hooks.
//
// Query-key contract (ISS-296), matched to `lib/ws/event-router.ts`:
//   • `['pm','config'|'policies'|'decisions', projectId]` — PM surfaces;
//     `['pm','decisions']` is invalidated on `pm.escalation`.
//   • `['issues','list', projectId]` — reuses the existing issues.* invalidation.
//   • `['issue', issueId, 'dependencies']` — invalidated on `dependencyChanged`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { pmApi } from "./api/pm-api";
import type { PipelineStage, PmConfigPatch, PmPolicyCreate, PmPolicyPatch } from "./types";

// ── Queries ────────────────────────────────────────────────────────────────

export function usePmConfig(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pm", "config", projectId],
    queryFn: () => pmApi.getConfig(projectId as string),
    enabled: !!projectId,
  });
}

export function usePmPolicies(projectId: string | undefined) {
  return useQuery({
    queryKey: ["pm", "policies", projectId],
    queryFn: () => pmApi.listPolicies(projectId as string),
    enabled: !!projectId,
  });
}

export function usePmDecisions(projectId: string | undefined, page: number, cause?: string) {
  return useQuery({
    queryKey: ["pm", "decisions", projectId, page, cause ?? null],
    queryFn: () => pmApi.listDecisions(projectId as string, page, 25, cause),
    enabled: !!projectId,
  });
}

export function useProjectIssues(projectId: string | undefined) {
  return useQuery({
    queryKey: ["issues", "list", projectId],
    queryFn: () => pmApi.listIssues(projectId as string),
    enabled: !!projectId,
  });
}

export function useIssueDependencies(issueId: string | undefined) {
  return useQuery({
    queryKey: ["issue", issueId, "dependencies"],
    queryFn: () => pmApi.getDependencies(issueId as string),
    enabled: !!issueId,
  });
}

// ── Mutation helpers ─────────────────────────────────────────────────────────

function useToastMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { success?: string; invalidate?: (qc: ReturnType<typeof useQueryClient>, args: TArgs) => void } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_data, args) => {
      opts.invalidate?.(qc, args);
      if (opts.success) toast({ title: opts.success, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}

// ── PM config / policies / run ───────────────────────────────────────────────

export function useUpdatePmConfig(projectId: string) {
  return useToastMutation((patch: PmConfigPatch) => pmApi.updateConfig(projectId, patch), {
    success: "PM config saved",
    invalidate: (qc) => qc.invalidateQueries({ queryKey: ["pm", "config", projectId] }),
  });
}

export function useCreatePolicy(projectId: string) {
  return useToastMutation((body: PmPolicyCreate) => pmApi.createPolicy(projectId, body), {
    success: "Policy created",
    invalidate: (qc) => qc.invalidateQueries({ queryKey: ["pm", "policies", projectId] }),
  });
}

export function useUpdatePolicy(projectId: string) {
  return useToastMutation(
    ({ id, patch }: { id: string; patch: PmPolicyPatch }) => pmApi.updatePolicy(projectId, id, patch),
    {
      success: "Policy updated",
      invalidate: (qc) => qc.invalidateQueries({ queryKey: ["pm", "policies", projectId] }),
    },
  );
}

export function useDeletePolicy(projectId: string) {
  return useToastMutation((id: string) => pmApi.deletePolicy(projectId, id), {
    success: "Policy deleted",
    invalidate: (qc) => qc.invalidateQueries({ queryKey: ["pm", "policies", projectId] }),
  });
}

export function useRunPm(projectId: string) {
  return useToastMutation((_: void) => pmApi.run(projectId), {
    success: "PM run queued",
    invalidate: (qc) => qc.invalidateQueries({ queryKey: ["pm", "decisions", projectId] }),
  });
}

// ── Dependency editing + dispatch ────────────────────────────────────────────

export function useAddDependency(issueId: string) {
  return useToastMutation(
    ({ dependsOnId, kind, reason }: { dependsOnId: string; kind?: string; reason?: string }) =>
      pmApi.addDependency(issueId, dependsOnId, kind, reason),
    {
      success: "Dependency added",
      invalidate: (qc) => qc.invalidateQueries({ queryKey: ["issue", issueId, "dependencies"] }),
    },
  );
}

export function useRemoveDependency(issueId: string) {
  return useToastMutation((edgeId: string) => pmApi.removeDependency(issueId, edgeId), {
    success: "Dependency removed",
    invalidate: (qc) => qc.invalidateQueries({ queryKey: ["issue", issueId, "dependencies"] }),
  });
}

export function useRunPipelineStep() {
  return useToastMutation(
    ({ issueId, stage }: { issueId: string; stage?: PipelineStage }) =>
      pmApi.runPipelineStep(issueId, stage),
    {
      success: "Pipeline step dispatched",
      invalidate: (qc, { issueId }) => {
        qc.invalidateQueries({ queryKey: ["issues", "list"] });
        qc.invalidateQueries({ queryKey: ["issue", issueId] });
        qc.invalidateQueries({ queryKey: ["agent-sessions"] });
      },
    },
  );
}
