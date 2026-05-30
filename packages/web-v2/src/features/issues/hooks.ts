"use client";

// web-v2 feature module: issues — React Query hooks (Part A list + shared).
//
// Query-key contract (ISS-293) — keys MUST match `lib/ws/event-router.ts`:
//   list   → ['issues','search', projectId, opts]   (issue.* events)
//   cost   → ['issue', id, 'cost']                  (lazy; no WS event)
//   deps   → ['issue', id, 'dependencies']          (dependencyChanged)
//   members→ ['project', projectId, 'members']
// Any other prefix → WS-driven invalidation silently no-ops.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { type PatchIssueInput, issuesApi } from "./api";
import type { IssueSearchOpts, IssueStatus } from "./types";

/** Issues search list. Keyed `['issues','search', projectId, opts]`. */
export function useIssues(projectId: string | undefined, opts: IssueSearchOpts) {
  return useQuery({
    queryKey: ["issues", "search", projectId, opts],
    queryFn: () => issuesApi.search(projectId as string, opts),
    enabled: !!projectId,
    placeholderData: (prev) => prev, // keep rows visible across page/filter changes
  });
}

/** Per-issue cost rollup. Keyed `['issue', id, 'cost']` — lazy + cached. */
export function useIssueCost(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["issue", id, "cost"],
    queryFn: () => issuesApi.costSummary(id as string),
    enabled: !!id && enabled,
    staleTime: 60_000,
  });
}

/** Per-issue dependency edges. Keyed `['issue', id, 'dependencies']` — lazy. */
export function useIssueDeps(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["issue", id, "dependencies"],
    queryFn: () => issuesApi.dependencies(id as string),
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}

/** Project members (assignee options). Keyed `['project', projectId, 'members']`. */
export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project", projectId, "members"],
    queryFn: () => issuesApi.members(projectId as string),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });
}

/** Shared mutation factory: invalidate `['issues']` on success, toast on error
 *  (409 ILLEGAL_TRANSITION / 400 ASSIGNEE_NOT_MEMBER map to friendly copy). */
function useIssueMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { successMessage?: string } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      if (opts.successMessage) toast({ title: opts.successMessage, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Update failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePatchIssue() {
  return useIssueMutation((args: { id: string; body: PatchIssueInput }) =>
    issuesApi.patch(args.id, args.body),
  );
}

export function useTransitionIssue() {
  const qc = useQueryClient();
  const mut = useIssueMutation(
    (args: { id: string; toStatus: IssueStatus; reason?: string }) =>
      issuesApi.transition(args.id, args.toStatus, args.reason),
  );
  // Also refresh the single-issue + activity caches (detail view) on success.
  return {
    ...mut,
    mutate: (args: { id: string; toStatus: IssueStatus; reason?: string }) =>
      mut.mutate(args, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["issue", args.id] });
          qc.invalidateQueries({ queryKey: ["activities", args.id] });
        },
      }),
  };
}

export function useRunPipelineStep() {
  return useIssueMutation((args: { id: string; stage?: string }) =>
    issuesApi.runPipelineStep(args.id, args.stage), { successMessage: "Pipeline step queued" });
}
